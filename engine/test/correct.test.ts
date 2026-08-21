// Unit tests for the domain-dictionary correction pass (npm test). No audio needed —
// correctSegments is pure text substitution driven by the seed JSON.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { correctSegments } from '../transcribe/correct.ts';
import type { Segment } from '../transcribe/transcriber.ts';

describe('correctSegments', () => {
  it('corrects a known single-word misspelling', () => {
    const segments: Segment[] = [{ start: 0, end: 1, text: 'Bu ay fre oranı yüksek.' }];
    const out = correctSegments(segments);
    assert.equal(out[0].text, 'Bu ay fire oranı yüksek.');
  });

  it('does not touch a word that merely contains a dictionary key as a substring', () => {
    const segments: Segment[] = [{ start: 0, end: 1, text: 'Frene bastı' }];
    const out = correctSegments(segments);
    assert.equal(out[0].text, 'Frene bastı');
  });

  it('preserves sentence-start capitalization on the corrected word', () => {
    const segments: Segment[] = [{ start: 0, end: 1, text: 'Fre oranı arttı.' }];
    const out = correctSegments(segments);
    assert.equal(out[0].text, 'Fire oranı arttı.');
  });

  it('leaves unknown words unchanged', () => {
    const segments: Segment[] = [{ start: 0, end: 1, text: 'termin bugün doldu' }];
    const out = correctSegments(segments);
    assert.equal(out[0].text, 'termin bugün doldu');
  });

  it('is pure: does not mutate the input segments', () => {
    const segments: Segment[] = [{ start: 0, end: 1, text: 'fre oranı' }];
    correctSegments(segments);
    assert.equal(segments[0].text, 'fre oranı');
  });

  it('preserves non-text fields untouched', () => {
    const segments: Segment[] = [
      { start: 1.5, end: 2.5, text: 'fre var', speaker: 'SPEAKER_00', duplicate: true },
    ];
    const out = correctSegments(segments);
    assert.equal(out[0].start, 1.5);
    assert.equal(out[0].end, 2.5);
    assert.equal(out[0].speaker, 'SPEAKER_00');
    assert.equal(out[0].duplicate, true);
  });
});
