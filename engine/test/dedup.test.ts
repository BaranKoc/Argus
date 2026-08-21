// Unit tests for chunk-boundary duplicate flagging (npm test). No audio needed —
// flagDuplicates is pure text/timing logic. The fixtures mirror the real artifact first
// captured for S3-F (the 24.5-25.26 segment that repeats the previous sentence in an
// impossible 0.76s).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { flagDuplicates } from '../transcribe/dedup.ts';
import type { Segment } from '../transcribe/transcriber.ts';

describe('flagDuplicates', () => {
  it('flags the S3-F chunk-boundary repeat (impossible 0.76s re-run of prior text)', () => {
    const segments: Segment[] = [
      { start: 21, end: 24.5, text: ' Onu diyecektim evet. Müşteriyi bugün ararım. Termini bir hafta uzatmak isterim.' },
      { start: 24.5, end: 25.26, text: ' Uzatmazlarsa? Onu diyecektim evet müşteriyi bugün ararım Termini bir hafta uzatmak isterim' },
    ];
    const out = flagDuplicates(segments);
    assert.equal(out[0].duplicate, undefined);
    assert.equal(out[1].duplicate, true);
  });

  it('does not flag a legitimate continuation that shares only a leading word', () => {
    const segments: Segment[] = [
      { start: 24.5, end: 25.26, text: ' Uzatmazlarsa? Onu diyecektim evet müşteriyi bugün ararım Termini bir hafta uzatmak isterim' },
      { start: 25.58, end: 28.58, text: ' Uzatmazlarsa fasol vereceğiz başka çare yok' },
    ];
    const out = flagDuplicates(segments);
    assert.equal(out[1].duplicate, undefined);
  });

  it('flags a full repeat even without usable timestamps (text evidence alone)', () => {
    const segments: Segment[] = [
      { start: null, end: null, text: 'bir iki üç dört beş' },
      { start: null, end: null, text: 'bir iki üç dört beş' },
    ];
    const out = flagDuplicates(segments);
    assert.equal(out[1].duplicate, true);
  });

  it('does not flag short repeated affirmations (below the token floor)', () => {
    const segments: Segment[] = [
      { start: 0, end: 1, text: 'Evet.' },
      { start: 1, end: 2, text: 'Evet.' },
    ];
    const out = flagDuplicates(segments);
    assert.equal(out[1].duplicate, undefined);
  });

  it('never flags the first segment', () => {
    const segments: Segment[] = [
      { start: 0, end: 3, text: 'Bu siparişte terminin çok sıkı olduğunu düşünüyorum.' },
    ];
    const out = flagDuplicates(segments);
    assert.equal(out[0].duplicate, undefined);
  });

  it('is pure: does not mutate the input segments', () => {
    const segments: Segment[] = [
      { start: 0, end: 3, text: 'bir iki üç dört beş' },
      { start: 3, end: 6, text: 'bir iki üç dört beş' },
    ];
    flagDuplicates(segments);
    assert.equal(segments[1].duplicate, undefined);
  });
});
