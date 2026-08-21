// Unit tests for speech detection (npm test). No audio needed — findSpeechBounds
// is pure signal arithmetic over decoded PCM, so the fixtures are synthetic: a
// tone stands in for speech (it clears the noise floor the same way) and low-level
// noise stands in for room tone. The scenarios mirror the real failures:
// S7-A (30s of an empty room -> `Altyazı M.K.`) and S7-D (silent lead-in before a
// sentence starting at 0:28) are the "silent room" and "speech after silence" cases.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findSpeechBounds, hasSpeech } from '../transcribe/vad.ts';
import { SAMPLE_RATE } from '../diarization-config.ts';

// Deterministic pseudo-random noise at `amplitude` — a seeded LCG, so a failure is
// always reproducible (Math.random would make this test flaky by construction).
function noise(seconds: number, amplitude: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  let seed = 12345;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff - 0.5) * 2 * amplitude;
  }
  return out;
}

// Write a speech-like signal at peak `amplitude` into `audio` over [from, to)
// seconds: a 200 Hz carrier amplitude-modulated at 4 Hz (the syllable rate). The
// envelope dips to 0.3 of peak rather than to zero, because that is what voicing
// does inside a word — it swells and fades between syllables but does not gate off
// eight times a second. A flat, unmodulated tone would be a hum, and a fully-gated
// one a tremolo; neither is a signal the detector should be asked about.
function addSpeech(audio: Float32Array, from: number, to: number, amplitude: number): void {
  const start = Math.round(from * SAMPLE_RATE);
  const end = Math.round(to * SAMPLE_RATE);
  for (let i = start; i < end; i++) {
    const envelope = 0.3 + 0.7 * Math.abs(Math.sin((Math.PI * 4 * i) / SAMPLE_RATE));
    audio[i] += Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * amplitude * envelope;
  }
}

// Write a flat, unmodulated tone — a click/door/hum, not a voice.
function addBurst(audio: Float32Array, from: number, to: number, amplitude: number): void {
  const start = Math.round(from * SAMPLE_RATE);
  const end = Math.round(to * SAMPLE_RATE);
  for (let i = start; i < end; i++) {
    audio[i] += Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * amplitude;
  }
}

describe('findSpeechBounds', () => {
  it('reports no speech for digital silence (ABS_FLOOR clamp)', () => {
    // Noise floor is 0 here, so `floor * SNR_MULT` is 0 too — only the absolute
    // floor keeps this from reading as 30s of speech.
    assert.equal(findSpeechBounds(new Float32Array(30 * SAMPLE_RATE)), null);
  });

  it('reports no speech for a silent room — the S7-A ghost-caption case', () => {
    assert.equal(findSpeechBounds(noise(30, 0.004)), null);
  });

  it('reports no speech for LOUD stationary noise (level is not the test — intermittency is)', () => {
    // Well above ABS_FLOOR and louder than S7-A's real room tone (-33 dBFS), yet
    // still dropped: steady hiss is its own floor and nothing in it stands 10 dB
    // above itself. This is what lets a noisy-but-empty room be dropped no matter
    // how loud the room is — the property an absolute threshold could not give us.
    assert.equal(findSpeechBounds(noise(30, 0.05)), null);
  });

  it('drops an empty room that contains a loud bump — S7-A as actually measured', () => {
    // The real S7-A is this shape, not the quiet hiss one imagines: room tone at
    // -33 dBFS plus a single -13 dBFS transient. The bump must not be allowed to
    // raise the peak enough to drag the threshold under the room tone (which is
    // what an ungated PEAK_FRACTION cap did — S7-A's peak/floor ratio is 11.9,
    // right at the edge where that cap starts to bind).
    const audio = noise(30, 0.038);
    addBurst(audio, 12, 12.05, 0.3);
    assert.equal(findSpeechBounds(audio), null);
  });

  it('brackets a late utterance and drops the silent lead-in — the S7-D case', () => {
    const audio = noise(35, 0.004);
    addSpeech(audio, 28, 33, 0.3);

    const bounds = findSpeechBounds(audio);
    assert.ok(bounds, 'speech after a silent lead-in must be found');
    // Padded outward, never inward: the bounds must not cut into the utterance.
    assert.ok(bounds.start / SAMPLE_RATE < 28, 'start must pad before the utterance');
    assert.ok(bounds.start / SAMPLE_RATE > 26.5, 'the 28s lead-in must be trimmed away');
    assert.ok(bounds.end / SAMPLE_RATE > 33, 'end must pad past the utterance');
  });

  it('keeps a wall-to-wall speech signal whole (never trims real speech)', () => {
    // Gapless audio: the noise floor is speech itself, so this is the case the
    // PEAK_FRACTION cap exists for. Without it the file would decode to NOTHING.
    const audio = noise(10, 0.004);
    addSpeech(audio, 0, 10, 0.3);

    const bounds = findSpeechBounds(audio);
    assert.ok(bounds);
    assert.equal(bounds.start, 0);
    assert.equal(bounds.end, audio.length);
  });

  it('ignores a transient too short to be speech', () => {
    // A single click must not anchor the bounds to the start of the file.
    const audio = noise(30, 0.004);
    addBurst(audio, 5, 5.05, 0.5);
    assert.equal(findSpeechBounds(audio), null);
  });

  it('finds quiet, far-mic speech against its own low noise floor', () => {
    // The S1-F/S2-F safety case: the utterance is faint in absolute terms but
    // still stands well above the gaps around it.
    const audio = noise(20, 0.002);
    addSpeech(audio, 8, 14, 0.02);

    const bounds = findSpeechBounds(audio);
    assert.ok(bounds, 'quiet speech must not be mistaken for silence');
    assert.ok(bounds.start / SAMPLE_RATE < 8);
    assert.ok(bounds.end / SAMPLE_RATE > 14);
  });

  it('returns null for audio shorter than one frame', () => {
    assert.equal(findSpeechBounds(new Float32Array(100)), null);
  });
});

describe('hasSpeech', () => {
  it('mirrors findSpeechBounds as a boolean', () => {
    const speech = noise(10, 0.004);
    addSpeech(speech, 2, 8, 0.3);

    assert.equal(hasSpeech(speech), true);
    assert.equal(hasSpeech(noise(10, 0.004)), false);
  });
});
