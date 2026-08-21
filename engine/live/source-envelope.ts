// The per-source loudness envelope that travels alongside the mixed live PCM.
//
// The recorder sums microphone and system audio into one mono stream before the engine
// ever sees a sample, and that sum is where "was this the room or the call?" is lost.
// Transcribing the two sources separately would double the ASR cost and leave two
// timelines to reconcile, so instead we keep this: a cheap RMS value per source per
// frame, on the same timeline the segments already live on. source-attribution.ts turns
// it into a verdict after diarization.
//
// This module imports NOTHING on purpose. The renderer bundles it (recorder.ts builds
// the envelope) and must not drag the engine's transformers/node dependencies into the
// browser bundle with it — the same split that keeps diarization-config.ts a leaf.

// 16 ms at the engine's 16 kHz. Short enough to catch an interjection, and a divisor of
// the recorder's 4096-sample callback, so every callback yields a whole number of frames
// and the envelope never drifts against the PCM it was measured from.
export const ENVELOPE_FRAME_SAMPLES = 256;

export interface SourceEnvelope {
  // Per-frame RMS of the raw microphone signal, before the mix.
  mic: Float32Array;
  // Per-frame RMS of the raw system (loopback) signal, before the mix. All zeros when
  // system capture was unavailable and the session is mic-only.
  system: Float32Array;
}

// The session's growing copy. Plain arrays because it is appended to for the length of a
// meeting and only becomes Float32Arrays once, at stop.
export interface EnvelopeTimeline {
  mic: number[];
  system: number[];
}

// Write a chunk's frames at the position its audio occupies on the session timeline
// rather than appending blindly, so the frame index stays a function of elapsed samples.
// A chunk that arrives short — the final Stop flush is one — would otherwise pull every
// later frame backwards, and attribution compares these frames against segment
// timestamps. Any gap is padded with silence, which is the honest reading of audio that
// reached the engine without an envelope.
export function appendEnvelopeFrames(
  timeline: EnvelopeTimeline,
  sampleOffset: number,
  envelope: SourceEnvelope,
): void {
  if (envelope.mic.length === 0) return;
  const start = Math.round(sampleOffset / ENVELOPE_FRAME_SAMPLES);
  while (timeline.mic.length < start) {
    timeline.mic.push(0);
    timeline.system.push(0);
  }
  for (let i = 0; i < envelope.mic.length; i++) {
    timeline.mic[start + i] = envelope.mic[i];
    timeline.system[start + i] = envelope.system[i] ?? 0;
  }
}
