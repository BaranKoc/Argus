// Voice activity detection: find where speech actually is, so silence never
// reaches Whisper.
//
// WHY THIS EXISTS: Whisper hallucinates captions into speech-free audio — a
// fully silent recording comes back as `Altyazı M.K.` (the caption credit it saw
// during training), and a leading silent chunk prefixes the same ghost onto a
// real transcript. Embedded silence between utterances is safe; only chunks with
// no speech at all are affected. So we detect the speech span and let the
// transcriber decode nothing else.
//
// WHY ENERGY AND NOT SILERO/SHERPA: sherpa-onnx bundles its own ONNX Runtime,
// which collides with the onnxruntime-node@1.21 that @huggingface/transformers
// loads — the reason diarization is exiled to a child process (see diarizer.ts).
// A VAD must run inline, in Whisper's own process, so it cannot be sherpa's. A
// frame-energy detector needs no model, no download and no native code.
//
// HOW IT DECIDES — by intermittency, not by loudness. "Silence" here is not quiet:
// measured over test_media, S7-A (30s of an empty room, the file that produces the
// ghost caption) carries room tone at -33 dBFS and a stray -13 dBFS bump. What
// separates it from speech is that its energy never MOVES — floor, median and peak
// sit within 2 dB — whereas speech towers over the gaps between its own words. So
// the threshold is derived from each file's own noise floor, and a loud transient
// is rejected by requiring speech to persist (MIN_SPEECH_FRAMES) rather than by
// being quiet. An absolute level could not do this: S7-A's room tone is louder
// than the quiet passages of real far-mic speech (S2-F floors at -43 dBFS).
//
// Pure and audio-file-free: takes decoded PCM, returns sample indices, so it is
// unit-testable on synthetic signals (see test/vad.test.ts).

import { SAMPLE_RATE } from '../diarization-config.ts';

// The span of speech within a signal, as sample indices into it (end exclusive).
export interface SpeechBounds {
  start: number;
  end: number;
}

// ~32 ms per frame: long enough for a stable RMS estimate, short enough to place
// a speech onset accurately.
const FRAME_SAMPLES = 512;

// The noise floor is the 10th percentile of frame energy — the file's own quiet
// (room tone, mic hiss), measured from the file rather than assumed, so a far mic
// and a close mic get different thresholds.
const NOISE_FLOOR_PERCENTILE = 0.1;

// Speech must exceed the noise floor by this factor (~10 dB). Real speech stands
// well above the gaps between its own words, so this is what places the start and
// end of an utterance inside a file that holds both speech and quiet.
const SNR_MULT = 3;

// Absolute lower bound on the threshold, for DIGITAL silence: there the floor is
// ~0, so `floor * SNR_MULT` is also ~0 and the faintest dither would read as
// speech. ~-60 dBFS — far below any real speech, including a distant mic.
const ABS_FLOOR = 1e-3;

// Safety net for GAPLESS audio. Because the noise floor is measured from the file
// itself, audio that is speech end to end (a tightly trimmed clip, no pauses) has a
// "floor" at speech level, and `floor * SNR_MULT` would clear the whole signal —
// the file would report NO speech and the transcript would be silently empty.
// Capping the threshold at this fraction of the loudest frame guarantees the
// strongest part of a signal always survives. Losing a real meeting is far worse
// than decoding some noise, so when in doubt this errs toward decoding.
const PEAK_FRACTION = 0.3;

// The cap above applies ONLY when the noise floor is itself this loud (~-30 dBFS).
//
// WHY IT IS GATED: the cap and the empty-room test pull in opposite directions —
// left unconditional, the cap drags the threshold below room tone and an empty room
// reads as wall-to-wall speech, which is the exact ghost-caption bug this module
// exists to kill. Gating resolves it, because the two cases differ in their FLOOR
// even though both look steady: measured over test_media, a real empty room (S7-A)
// floors at -35 dBFS and every scenario with speech in it floors at -33 dBFS or
// below (S2-F: -43), whereas gapless speech would floor at its own speaking level,
// ~-25 dBFS. So a floor above this can only be content, never a room.
const GAPLESS_FLOOR = 0.032;

// A speech onset must persist this long (~200 ms) to count. A key click, a door,
// or a single-frame spike is not speech, and without this any transient would
// anchor the bounds back to the start of the file and defeat the trim.
const MIN_SPEECH_FRAMES = Math.round((0.2 * SAMPLE_RATE) / FRAME_SAMPLES);

// Keep this much audio (~0.5 s) either side of the detected span. Energy rises
// slightly after a word truly begins, so the bounds always cut a little inside
// the speech; the pad buys back the leading consonant and the trailing decay.
// Cheap insurance — half a second of silence never hallucinated anything (S6).
const PAD_SAMPLES = Math.round(0.5 * SAMPLE_RATE);

// Root-mean-square amplitude of one frame.
function frameRms(audio: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / (to - from));
}

// Value at `p` (0..1) through a sorted copy of `values`.
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

// Locate the speech span in decoded 16 kHz mono PCM, padded and clamped to the
// signal. Returns null when the audio holds no speech at all — the caller should
// then skip decoding entirely rather than hand Whisper an empty room.
export function findSpeechBounds(audio: Float32Array): SpeechBounds | null {
  const frameCount = Math.floor(audio.length / FRAME_SAMPLES);
  // Shorter than a single frame: nothing to measure, and far too short to be a
  // meaningful utterance either way.
  if (frameCount === 0) return null;

  const rms: number[] = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const from = f * FRAME_SAMPLES;
    rms[f] = frameRms(audio, from, from + FRAME_SAMPLES);
  }

  // Looped, not Math.max(...rms): a 40-minute meeting is ~75k frames and spreading
  // that many arguments overflows the call stack.
  let peak = 0;
  for (const v of rms) if (v > peak) peak = v;

  const noiseFloor = percentile(rms, NOISE_FLOOR_PERCENTILE);
  let threshold = noiseFloor * SNR_MULT;
  if (noiseFloor > GAPLESS_FLOOR) threshold = Math.min(threshold, peak * PEAK_FRACTION);
  threshold = Math.max(ABS_FLOOR, threshold);

  // First and last frame belonging to a run of >= MIN_SPEECH_FRAMES loud frames.
  let first = -1;
  let last = -1;
  let runStart = -1;
  for (let f = 0; f <= frameCount; f++) {
    const loud = f < frameCount && rms[f] > threshold;
    if (loud) {
      if (runStart < 0) runStart = f;
      continue;
    }
    // Run ended at f-1 (the f === frameCount pass closes a run at the very end).
    if (runStart >= 0 && f - runStart >= MIN_SPEECH_FRAMES) {
      if (first < 0) first = runStart;
      last = f - 1;
    }
    runStart = -1;
  }

  if (first < 0) return null;

  return {
    start: Math.max(0, first * FRAME_SAMPLES - PAD_SAMPLES),
    end: Math.min(audio.length, (last + 1) * FRAME_SAMPLES + PAD_SAMPLES),
  };
}

// Whether the signal contains any speech. Used by the sequential decoder to drop
// a whole window without decoding it.
export function hasSpeech(audio: Float32Array): boolean {
  return findSpeechBounds(audio) !== null;
}
