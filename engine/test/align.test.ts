// Unit tests for speaker alignment (npm test). No audio or models needed — these
// exercise the pure overlap logic in align.ts and the dialogue rendering in index.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assignSpeakers } from '../transcribe/align.ts';
import { segmentsToDialogue, type Segment } from '../index.ts';
import type { SpeakerSegment } from '../diarize/diarizer.ts';

describe('assignSpeakers (overlap-based)', () => {
  const diar: SpeakerSegment[] = [
    { start: 0, end: 5, speaker: 'SPEAKER_00' },
    { start: 5, end: 10, speaker: 'SPEAKER_01' },
  ];

  it('assigns each segment to the most-overlapping speaker turn', () => {
    const segments: Segment[] = [
      { start: 0.5, end: 4.5, text: 'Merhaba' }, // fully within SPEAKER_00
      { start: 6, end: 9, text: 'Selam' }, // fully within SPEAKER_01
    ];
    const out = assignSpeakers(segments, diar);
    assert.equal(out[0].speaker, 'SPEAKER_00');
    assert.equal(out[1].speaker, 'SPEAKER_01');
  });

  it('picks the dominant speaker when a segment straddles a boundary', () => {
    const segments: Segment[] = [
      { start: 4, end: 7, text: 'ortada' }, // 1s in SPEAKER_00, 2s in SPEAKER_01
    ];
    const out = assignSpeakers(segments, diar);
    assert.equal(out[0].speaker, 'SPEAKER_01');
  });

  it('leaves segments with null timestamps unlabelled', () => {
    const segments: Segment[] = [{ start: null, end: null, text: 'kısa klip' }];
    const out = assignSpeakers(segments, diar);
    assert.equal(out[0].speaker, undefined);
  });

  it('leaves a segment unlabelled when it overlaps no turn', () => {
    const segments: Segment[] = [{ start: 20, end: 25, text: 'sonra' }];
    const out = assignSpeakers(segments, diar);
    assert.equal(out[0].speaker, undefined);
  });

  it('returns segments unchanged when there is no diarization', () => {
    const segments: Segment[] = [{ start: 0, end: 5, text: 'a' }];
    assert.deepEqual(assignSpeakers(segments, []), segments);
  });
});

describe('assignSpeakers (overlap flag)', () => {
  const diar: SpeakerSegment[] = [
    { start: 0, end: 5, speaker: 'SPEAKER_00' },
    { start: 5, end: 10, speaker: 'SPEAKER_01' },
  ];

  it('flags a segment meaningfully shared by two speakers', () => {
    const segments: Segment[] = [{ start: 3, end: 7, text: 'üst üste' }]; // 2s + 2s
    const out = assignSpeakers(segments, diar);
    assert.equal(out[0].overlap, true);
  });

  it('does not flag a segment that sits cleanly in one speaker', () => {
    const segments: Segment[] = [{ start: 0.5, end: 4.5, text: 'tek kişi' }];
    const out = assignSpeakers(segments, diar);
    assert.equal(out[0].overlap, undefined);
  });

  it('does not flag when the second speaker is only an edge clip', () => {
    // 4s in SPEAKER_00, 0.6s in SPEAKER_01: the clip clears the absolute floor but
    // not the 30% fraction, so it is not counted as a real second speaker.
    const segments: Segment[] = [{ start: 1, end: 5.6, text: 'kenardan değen' }];
    const out = assignSpeakers(segments, diar);
    assert.equal(out[0].speaker, 'SPEAKER_00');
    assert.equal(out[0].overlap, undefined);
  });
});

describe('segmentsToDialogue', () => {
  it('renders speaker-prefixed lines and merges consecutive same-speaker segments', () => {
    const segments: Segment[] = [
      { start: 0, end: 2, text: 'Merhaba', speaker: 'SPEAKER_00' },
      { start: 2, end: 4, text: 'nasılsınız', speaker: 'SPEAKER_00' },
      { start: 4, end: 6, text: 'İyiyim', speaker: 'SPEAKER_01' },
    ];
    assert.equal(
      segmentsToDialogue(segments),
      'SPEAKER_00: Merhaba nasılsınız\nSPEAKER_01: İyiyim',
    );
  });

  it('falls back to plain joined text when no speakers are present', () => {
    const segments: Segment[] = [
      { start: 0, end: 2, text: 'Merhaba' },
      { start: 2, end: 4, text: 'dünya' },
    ];
    assert.equal(segmentsToDialogue(segments), 'Merhaba dünya');
  });
});

// Labels are no longer suppressible, so what matters is that unlabelled segments still
// render as plain text — that is the ONLY thing standing between a diarization-off run
// and a stray "SPEAKER_??:" prefix reaching the LLM.
describe('segmentsToDialogue with no speakers present', () => {
  it('renders plain text and preserves overlap/duplicate handling', () => {
    const segments: Segment[] = [
      { start: 0, end: 2, text: 'a' },
      { start: 2, end: 4, text: 'b', overlap: true },
      { start: 4, end: 5, text: 'c', duplicate: true },
    ];
    // 'c' is duplicate-flagged, so it is excluded from the joined text but stays in the array.
    assert.equal(segmentsToDialogue(segments), 'a b');
    assert.equal(segments[2].duplicate, true);
  });
});
