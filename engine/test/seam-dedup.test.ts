// Unit tests for live-seam duplicate flagging (npm test). No audio needed —
// flagSeamDuplicates is pure position logic: fresh audio starts at seamSec, so a
// segment whose midpoint lands before that is a re-decode of the previous round's
// tail. Covers the short live-seam fragments that flagDuplicates misses because they fall
// below its token floor.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { flagSeamDuplicates, flagBoundaryOrphans } from '../live/seam-dedup.ts';
import type { Segment } from '../transcribe/transcriber.ts';

describe('flagSeamDuplicates', () => {
  // Round boundary at 6.5s: tail was the prior round's last 1.5s (5.0-6.5s), re-decoded
  // at the head of this round, then the new audio from 6.5s on.
  const seamSec = 6.5;

  it('flags a short seam fragment that ends inside the re-decoded tail', () => {
    const segments: Segment[] = [
      { start: 5.0, end: 6.18, text: 'gelecek müşteri ziyareten.' },
    ];
    const out = flagSeamDuplicates(segments, seamSec);
    assert.equal(out[0].duplicate, true);
  });

  it('keeps the segment that straddles the seam (carries the fresh word)', () => {
    const segments: Segment[] = [
      { start: 6.0, end: 7.98, text: 'gelecek müşteri ziyaretleri planlayalım.' },
    ];
    const out = flagSeamDuplicates(segments, seamSec);
    assert.equal(out[0].duplicate, undefined);
  });

  // A straddler whose fresh portion is SHORT still carries new content
  // ("...25'ine çekebiliriz"),
  // so it must be KEPT even though its midpoint sits before the seam. Keying on `end`
  // (not the midpoint) is what protects it.
  it('keeps a straddler with a short fresh tail (midpoint before the seam)', () => {
    const segments: Segment[] = [
      { start: 30.51, end: 33.33, text: "Sevkiyatı ayın 25'ine çekebiliriz." },
    ];
    const out = flagSeamDuplicates(segments, 32.0);
    assert.equal(out[0].duplicate, undefined);
  });

  it('keeps a segment fully in the fresh audio', () => {
    const segments: Segment[] = [
      { start: 7.0, end: 9.0, text: 'numuneden başlayalım.' },
    ];
    const out = flagSeamDuplicates(segments, seamSec);
    assert.equal(out[0].duplicate, undefined);
  });

  it('flags nothing on the first round (seamSec = 0, nothing precedes it)', () => {
    const segments: Segment[] = [
      { start: 0, end: 3, text: 'toplantıya başlayalım.' },
      { start: 3, end: 6, text: 'numune onayı bekliyoruz.' },
    ];
    const out = flagSeamDuplicates(segments, 0);
    assert.equal(out[0].duplicate, undefined);
    assert.equal(out[1].duplicate, undefined);
  });

  it('leaves timestamp-less segments untouched (can\'t be positioned)', () => {
    const segments: Segment[] = [
      { start: null, end: null, text: 'whole-clip fallback text' },
    ];
    const out = flagSeamDuplicates(segments, seamSec);
    assert.equal(out[0].duplicate, undefined);
  });

  it('does not mutate the input segments', () => {
    const segments: Segment[] = [{ start: 5.0, end: 6.18, text: 'seam repeat' }];
    flagSeamDuplicates(segments, seamSec);
    assert.equal(segments[0].duplicate, undefined);
  });
});

describe('flagBoundaryOrphans', () => {
  // Live S1-C: round N emits the truncated "Sevkiyatı ayın", round N+1's tail re-decode
  // yields the fuller "Sevkiyatı ayın 25'ine çekebiliriz." straddling the seam. The date
  // lives only in the fuller (kept) segment; the truncated echo must be flagged.
  it('flags a truncated fragment subsumed by the next round\'s fuller re-decode', () => {
    const segments: Segment[] = [
      { start: 30.5, end: 32.0, text: 'Sevkiyatı ayın' },
      { start: 30.512, end: 33.332, text: "Sevkiyatı ayın 25'ine çekebiliriz." },
    ];
    const out = flagBoundaryOrphans(segments);
    assert.equal(out[0].duplicate, true);
    assert.equal(out[1].duplicate, undefined); // the fuller straddler is kept
  });

  it('flags a doubled short segment subsumed by a fuller neighbor', () => {
    const segments: Segment[] = [
      { start: 39.28, end: 39.89, text: 'Anlaştık.' },
      { start: 38.5, end: 41.5, text: 'Anlaştık. Toplantıyı burada bitirelim.' },
    ];
    const out = flagBoundaryOrphans(segments);
    assert.equal(out[0].duplicate, true);
    assert.equal(out[1].duplicate, undefined);
  });

  // Prefix (not fuzzy) matching is what protects genuine near-synonyms: these diverge on
  // the last token, so neither is the other's prefix — both survive.
  it('keeps near-synonyms that diverge on the last token (not a prefix)', () => {
    const segments: Segment[] = [
      { start: 22.5, end: 24.0, text: 'Ben takip ediyorum.' },
      { start: 22.5, end: 24.5, text: 'Ben takip ederim.' },
    ];
    const out = flagBoundaryOrphans(segments);
    assert.equal(out[0].duplicate, undefined);
    assert.equal(out[1].duplicate, undefined);
  });

  // Same opening words but no shared audio — a real later utterance, not a re-decode.
  it('keeps a same-prefix segment that does not time-overlap', () => {
    const segments: Segment[] = [
      { start: 1.0, end: 2.0, text: 'Numune onayı' },
      { start: 40.0, end: 42.0, text: 'Numune onayı bekliyoruz hâlâ.' },
    ];
    const out = flagBoundaryOrphans(segments);
    assert.equal(out[0].duplicate, undefined);
    assert.equal(out[1].duplicate, undefined);
  });

  // Equal token count is not "fuller" — a bare repeat, left for flagDuplicates/seam pass.
  it('does not flag when the neighbor is not strictly longer', () => {
    const segments: Segment[] = [
      { start: 5.0, end: 6.0, text: 'aynı söz' },
      { start: 5.5, end: 6.5, text: 'aynı söz' },
    ];
    const out = flagBoundaryOrphans(segments);
    assert.equal(out[0].duplicate, undefined);
  });

  it('skips already-flagged segments when picking the fuller neighbor', () => {
    // The immediate next segment is already a seam duplicate; the orphan should be
    // compared against the following real segment, not the flagged one.
    const segments: Segment[] = [
      { start: 30.5, end: 32.0, text: 'Sevkiyatı ayın' },
      { start: 30.6, end: 31.0, text: 'ayın', duplicate: true },
      { start: 30.512, end: 33.332, text: "Sevkiyatı ayın 25'ine çekebiliriz." },
    ];
    const out = flagBoundaryOrphans(segments);
    assert.equal(out[0].duplicate, true);
    assert.equal(out[2].duplicate, undefined);
  });

  it('leaves timestamp-less segments untouched (can\'t be positioned)', () => {
    const segments: Segment[] = [
      { start: null, end: null, text: 'Sevkiyatı ayın' },
      { start: null, end: null, text: "Sevkiyatı ayın 25'ine çekebiliriz." },
    ];
    const out = flagBoundaryOrphans(segments);
    assert.equal(out[0].duplicate, undefined);
  });

  it('does not mutate the input segments', () => {
    const segments: Segment[] = [
      { start: 30.5, end: 32.0, text: 'Sevkiyatı ayın' },
      { start: 30.512, end: 33.332, text: "Sevkiyatı ayın 25'ine çekebiliriz." },
    ];
    flagBoundaryOrphans(segments);
    assert.equal(segments[0].duplicate, undefined);
  });
});
