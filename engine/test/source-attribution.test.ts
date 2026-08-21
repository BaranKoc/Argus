// Unit tests for local/remote attribution (npm test -w engine). No audio needed — the
// attribution reads an RMS envelope, so a test builds the envelope directly and states
// the acoustic situation it stands for: "the room talked from 0 to 2s while the call was
// silent", "the call talked and leaked into the mic at -20 dB", and so on.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attributeSources, resolveSpeakerSources } from '../live/source-attribution.ts';
import {
  ENVELOPE_FRAME_SAMPLES,
  appendEnvelopeFrames,
  type EnvelopeTimeline,
  type SourceEnvelope,
} from '../live/source-envelope.ts';
import { SAMPLE_RATE } from '../diarization-config.ts';
import type { Segment } from '../transcribe/transcriber.ts';

const FRAME_SECONDS = ENVELOPE_FRAME_SAMPLES / SAMPLE_RATE;
const SPEECH = 0.2; // a comfortable speaking level in RMS
const NOISE = 0.001; // room tone / digital silence floor

function frames(seconds: number): number {
  return Math.round(seconds / FRAME_SECONDS);
}

// Build an envelope from spans of [fromSec, toSec, micRms, systemRms). Everything
// outside the given spans sits at the noise floor.
function envelope(
  totalSeconds: number,
  spans: Array<[number, number, number, number]>,
): SourceEnvelope {
  const count = frames(totalSeconds);
  const mic = new Float32Array(count).fill(NOISE);
  const system = new Float32Array(count).fill(NOISE);
  for (const [from, to, micRms, systemRms] of spans) {
    for (let i = frames(from); i < Math.min(count, frames(to)); i++) {
      mic[i] = micRms;
      system[i] = systemRms;
    }
  }
  return { mic, system };
}

describe('appendEnvelopeFrames', () => {
  const chunk = (mic: number[]): SourceEnvelope => ({
    mic: Float32Array.from(mic),
    system: Float32Array.from(mic.map(() => 0)),
  });

  it('lays consecutive chunks end to end', () => {
    const timeline: EnvelopeTimeline = { mic: [], system: [] };
    appendEnvelopeFrames(timeline, 0, chunk([1, 2]));
    appendEnvelopeFrames(timeline, ENVELOPE_FRAME_SAMPLES * 2, chunk([3, 4]));
    assert.deepEqual(timeline.mic, [1, 2, 3, 4]);
  });

  // The case blind appending would get wrong: a chunk carrying fewer frames than its
  // audio (or none at all) must not pull the following chunk backwards in time.
  it('pads a gap with silence so later frames keep their timestamps', () => {
    const timeline: EnvelopeTimeline = { mic: [], system: [] };
    appendEnvelopeFrames(timeline, 0, chunk([1]));
    appendEnvelopeFrames(timeline, ENVELOPE_FRAME_SAMPLES * 4, chunk([5]));
    assert.deepEqual(timeline.mic, [1, 0, 0, 0, 5]);
  });

  it('ignores an empty chunk', () => {
    const timeline: EnvelopeTimeline = { mic: [], system: [] };
    appendEnvelopeFrames(timeline, ENVELOPE_FRAME_SAMPLES * 3, chunk([]));
    assert.deepEqual(timeline.mic, []);
  });
});

describe('attributeSources — per segment', () => {
  // One session where the room speaks first and the call answers. Both channels are
  // active, so both calibrate, which is the case the ratio is actually for.
  const conversation = envelope(8, [
    [0, 2, SPEECH, NOISE],
    [4, 6, NOISE, SPEECH],
  ]);

  it('labels a mic-only span local', () => {
    const out = attributeSources([{ start: 0.2, end: 1.8, text: 'odadan konuşma' }], conversation);
    assert.equal(out[0].source, 'local');
  });

  it('labels a system-only span remote', () => {
    const out = attributeSources([{ start: 4.2, end: 5.8, text: 'toplantıdan konuşma' }], conversation);
    assert.equal(out[0].source, 'remote');
  });

  // Attribution answers a different question than diarization does, and must not depend
  // on it: with Pyannote off, unavailable, or degraded to no speakers at all, every
  // sentence still gets its own local/remote flag from its own energy.
  it('flags every segment with no speakers anywhere in the transcript', () => {
    const segments: Segment[] = [
      { start: 0.2, end: 1.8, text: 'odadan' },
      { start: 4.2, end: 5.8, text: 'toplantıdan' },
    ];
    const out = attributeSources(segments, conversation);
    assert.deepEqual(out.map((s) => s.source), ['local', 'remote']);
    assert.deepEqual(out.map((s) => s.speaker), [undefined, undefined]);
  });

  it('leaves a silent span unattributed rather than guessing', () => {
    const out = attributeSources([{ start: 2.2, end: 3.8, text: 'sessizlik' }], conversation);
    assert.equal(out[0].source, undefined);
  });

  it('leaves a segment without timestamps alone', () => {
    const out = attributeSources([{ start: null, end: null, text: 'zamansız' }], conversation);
    assert.equal(out[0].source, undefined);
  });

  // The echo case that decides whether this feature is usable on speakers: the call is
  // playing out loud and comes back into the microphone ~20 dB down. The system channel
  // still dominates, so the verdict must stay 'remote'.
  it('stays remote when the call leaks into the mic through the speakers', () => {
    const leaky = envelope(4, [[0, 3, SPEECH * 0.1, SPEECH]]);
    const out = attributeSources([{ start: 0.2, end: 2.8, text: 'yankılı' }], leaky);
    assert.equal(out[0].source, 'remote');
  });

  // The other half of the echo story: suppressing the leak must not eat the room's own
  // voice. Here the call holds a steady open-mic hiss the whole time and someone in the
  // room speaks over it — the room is the only thing actually talking.
  it('keeps room speech local when the call is only holding an open line', () => {
    const openLine = envelope(6, [
      [0, 6, NOISE * 3, 0.03],
      [2, 4, SPEECH, 0.03],
    ]);
    const out = attributeSources([{ start: 2.2, end: 3.8, text: 'odadan' }], openLine);
    assert.equal(out[0].source, 'local');
  });

  it('reports mixed when both sides are genuinely talking at once', () => {
    const crosstalk = envelope(8, [
      [0, 2, SPEECH, NOISE],
      [2, 4, SPEECH, SPEECH],
      [4, 6, NOISE, SPEECH],
    ]);
    const out = attributeSources([{ start: 2.2, end: 3.8, text: 'aynı anda' }], crosstalk);
    assert.equal(out[0].source, 'mixed');
  });
});

describe('attributeSources — degenerate captures', () => {
  it('calls everything local when there is no system capture at all', () => {
    const micOnly = envelope(4, [[0, 3, SPEECH, 0]]);
    micOnly.system.fill(0);
    const out = attributeSources([{ start: 0.2, end: 2.8, text: 'mikrofon' }], micOnly);
    assert.equal(out[0].source, 'local');
  });

  // A remote-only meeting leaves the mic channel with nothing but hiss. Normalising that
  // hiss against itself would stretch it to full scale and steal the verdict, so the
  // absolute activity floor has to reject the channel outright.
  it('does not let an idle microphone outvote the call', () => {
    const remoteOnly = envelope(4, [[0, 3, NOISE, SPEECH]]);
    const out = attributeSources([{ start: 0.2, end: 2.8, text: 'sadece uzak' }], remoteOnly);
    assert.equal(out[0].source, 'remote');
  });

  it('returns the segments untouched when there is no envelope', () => {
    const segments: Segment[] = [{ start: 0, end: 1, text: 'x' }];
    assert.equal(attributeSources(segments, null), segments);
    assert.equal(attributeSources(segments, { mic: new Float32Array(0), system: new Float32Array(0) }), segments);
  });
});

describe('resolveSpeakerSources', () => {
  it('gives a speaker the source that carries most of its speaking time', () => {
    const segments: Segment[] = [
      { start: 0, end: 4, text: 'a', speaker: 'SPEAKER_00', source: 'remote' },
      { start: 4, end: 8, text: 'b', speaker: 'SPEAKER_00', source: 'remote' },
      { start: 8, end: 9, text: 'c', speaker: 'SPEAKER_00', source: 'local' },
      { start: 9, end: 12, text: 'd', speaker: 'SPEAKER_01', source: 'local' },
    ];
    const resolved = resolveSpeakerSources(segments);
    assert.equal(resolved.get('SPEAKER_00'), 'remote');
    assert.equal(resolved.get('SPEAKER_01'), 'local');
  });

  it('leaves a genuinely split speaker mixed instead of picking a winner', () => {
    const segments: Segment[] = [
      { start: 0, end: 2, text: 'a', speaker: 'SPEAKER_00', source: 'remote' },
      { start: 2, end: 4, text: 'b', speaker: 'SPEAKER_00', source: 'local' },
    ];
    assert.equal(resolveSpeakerSources(segments).get('SPEAKER_00'), 'mixed');
  });

  it('ignores duplicate-flagged segments so a seam repeat cannot vote twice', () => {
    const segments: Segment[] = [
      { start: 0, end: 6, text: 'a', speaker: 'SPEAKER_00', source: 'local' },
      { start: 6, end: 20, text: 'a', speaker: 'SPEAKER_00', source: 'remote', duplicate: true },
    ];
    assert.equal(resolveSpeakerSources(segments).get('SPEAKER_00'), 'local');
  });
});

describe('attributeSources — speaker consensus', () => {
  // The payoff: one segment of a remote speaker lands during a pause in the call (a
  // dropped packet, a breath) and reads local on its own evidence. The speaker's other
  // segments outweigh it, so the whole speaker reads remote.
  it('overrules a stray segment with the speaker verdict', () => {
    const session = envelope(12, [
      [0, 4, NOISE, SPEECH],
      [6, 10, NOISE, SPEECH],
      [4, 6, SPEECH, NOISE],
    ]);
    const segments: Segment[] = [
      { start: 0.2, end: 3.8, text: 'a', speaker: 'SPEAKER_00' },
      { start: 4.2, end: 5.8, text: 'b', speaker: 'SPEAKER_00' },
      { start: 6.2, end: 9.8, text: 'c', speaker: 'SPEAKER_00' },
    ];
    const out = attributeSources(segments, session);
    assert.deepEqual(out.map((s) => s.source), ['remote', 'remote', 'remote']);
  });
});
