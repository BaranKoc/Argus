// Unit tests for the Turkish-aware benchmark metrics (npm test). Pure text — no model.
// The critical cases are number word<->digit and percent equivalence, WITHOUT hiding
// real numeric errors (%70 != yüzde 7).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeText, wer, domainRecall, timestampQuality, flagCounts } from '../bench/metrics.ts';
import type { Segment } from '../transcribe/transcriber.ts';

describe('normalizeText (Turkish number/percent normalization)', () => {
  it('maps number words to digits so "3 konu" == "üç konu"', () => {
    assert.equal(normalizeText('3 konu'), normalizeText('üç konu'));
  });

  it('handles compound number words (yirmi beş -> 25)', () => {
    assert.equal(normalizeText('yirmi beş metre'), '25 metre');
    assert.equal(normalizeText('yüz elli'), '150');
  });

  it('makes "yüzde 7" == "%7" == "yüzde yedi"', () => {
    const a = normalizeText('yüzde 7');
    assert.equal(a, '%7');
    assert.equal(normalizeText('%7'), a);
    assert.equal(normalizeText('yüzde yedi'), a);
  });

  it('keeps a REAL numeric error distinct (%70 != yüzde 7)', () => {
    assert.notEqual(normalizeText('%70'), normalizeText('yüzde 7'));
  });

  it('flattens digit separators consistently (3.500 == 3500)', () => {
    assert.equal(normalizeText('3.500 metre'), normalizeText('3500 metre'));
  });

  it('lowercases Turkish-correctly and drops punctuation', () => {
    assert.equal(normalizeText('İyi. Tamam!'), 'iyi tamam');
  });
});

describe('wer (divergence from reference)', () => {
  it('is 0 for identical (after normalization) text', () => {
    assert.equal(wer('Bugün 3 konu var.', 'Bugün üç konu var.').wer, 0);
  });

  it('grows with token differences', () => {
    const r = wer('boyahane termini çok sıkı', 'boyahane sorunu çok gevşek');
    assert.equal(r.refTokens, 4);
    assert.equal(r.distance, 2); // termini->sorunu, sıkı->gevşek
    assert.equal(r.wer, 0.5);
  });
});

describe('domainRecall', () => {
  it('counts present terms and misses corrupted ones', () => {
    const text = 'boyahane termini ve numune onayı';
    const r = domainRecall(text, ['boyahane', 'numune', 'sevkiyat']);
    assert.equal(r.found, 2); // boyahane + numune present, sevkiyat absent
    assert.equal(r.total, 3);
    assert.equal(r.terms.find((t) => t.term === 'sevkiyat')!.present, false);
  });
});

describe('timestampQuality + flagCounts', () => {
  const segments: Segment[] = [
    { start: 0, end: 2.5, text: 'a' },
    { start: 2.5, end: 5, text: 'b', duplicate: true },
    { start: 5, end: 8.3, text: 'c', overlap: true },
  ];

  it('reports the decimal vs integer-stuck boundary split', () => {
    const q = timestampQuality(segments);
    assert.equal(q.boundaries, 6); // 0, 2.5, 2.5, 5, 5, 8.3
    assert.equal(q.decimal, 3); // both 2.5s + 8.3
  });

  it('counts duplicate and overlap flags', () => {
    assert.deepEqual(flagCounts(segments), { duplicate: 1, overlap: 1 });
  });
});
