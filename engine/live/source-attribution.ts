// Deciding, per segment, whether a voice came from the room (microphone) or from the
// call (system audio) — issue #45. Runs in finalize, after diarization, over the
// envelope the recorder measured while capturing.
//
// Why the system channel is the side we trust: Windows loopback captures the render
// endpoint, so the microphone NEVER appears in it. The reverse is not true — on
// speakers instead of headphones the call leaks back into the mic — so every rule here
// is written to read the system channel as evidence and treat the mic as the noisy one.
// AEC (echoCancellation on getUserMedia) shrinks that leak but cannot be assumed gone.
//
// Why the echo coupling is estimated and subtracted first: normalising each channel
// against itself is not enough on speakers, because a microphone that only ever hears
// the call's echo calibrates that echo as its own speech level and then votes with it.
// So we measure how much of the system signal comes back into the mic — a low quantile
// of mic/system across frames where the call is clearly talking, low so that the moments
// someone in the room talks over the call cannot inflate it — and subtract that
// prediction from the mic before anything else looks at it. Headphones simply produce a
// coupling near zero and nothing changes.
//
// Why each channel is normalised against itself: system playback routinely runs far
// louder than a desk microphone, so raw energies are not comparable across channels.
// Scaling each channel against its OWN speech level (P90) above its OWN noise floor
// (P10) turns the comparison into "how active is this channel, for this channel", which
// self-calibrates to whatever gain the machine happens to run — including the
// autoGainControl the mic capture asks for.
//
// Why the speaker-level consensus is the real verdict: one segment can be misattributed
// by an echo burst, a notification sound or a shared video, but a diarized speaker
// produces many segments and nobody moves from the room into the call mid-meeting. A
// duration-weighted majority over a speaker's segments therefore survives a good deal of
// per-segment noise, which is why the per-segment ratio is deliberately allowed to be
// only roughly right.

import { SAMPLE_RATE } from '../diarization-config.ts';
import { ENVELOPE_FRAME_SAMPLES, type SourceEnvelope } from './source-envelope.ts';
import type { Segment } from '../transcribe/transcriber.ts';

export type SegmentSource = 'local' | 'remote' | 'mixed';

const FRAME_SECONDS = ENVELOPE_FRAME_SAMPLES / SAMPLE_RATE;

// A channel whose loudest frames never reach this counts as silent for the whole
// session. Without the absolute floor, normalising an idle channel would stretch its
// own hiss up to a full-scale 1.0 and let silence outvote speech.
const MIN_ACTIVE_RMS = 0.01; // ≈ -40 dBFS
const MIN_DYNAMIC_RANGE = 3;

// System share of the segment's energy. The band between the two is 'mixed': both sides
// audible at once (genuine crosstalk, or echo the AEC did not catch).
const REMOTE_SHARE = 0.6;
const LOCAL_SHARE = 0.4;

// Mean squared normalised level below which the segment's window carries no usable
// evidence — silence, or speech too faint to place. Such segments keep no source at all
// rather than being guessed at.
const MIN_MEAN_ENERGY = 0.01;

// The dominant source must carry this much of a speaker's decided weight; short of it
// the speaker stays 'mixed' instead of being handed a coin-flip winner.
const CONSENSUS_SHARE = 0.6;

// Echo coupling: measured only where the call is at least halfway to its own speech
// level, taken at a low quantile so overlapping room speech cannot inflate it, and
// capped so a pathological estimate can never cancel the microphone outright. Requiring
// a third of a second of such frames keeps a single loud beep from setting it.
const ECHO_REFERENCE_LEVEL = 0.5;
const ECHO_QUANTILE = 0.25;
const ECHO_MIN_FRAMES = 20;
const MAX_ECHO_COUPLING = 0.8;

interface ChannelScale {
  floor: number;
  span: number;
}

function percentile(sorted: Float32Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

// null means "this channel never carried speech", which is the honest answer for a
// mic-only session (system frames are all zeros) as much as for a muted microphone.
function calibrate(frames: Float32Array): ChannelScale | null {
  if (frames.length === 0) return null;
  const sorted = Float32Array.from(frames).sort();
  const floor = percentile(sorted, 0.1);
  const reference = percentile(sorted, 0.9);
  if (reference < MIN_ACTIVE_RMS) return null;
  if (reference < floor * MIN_DYNAMIC_RANGE) return null;
  return { floor, span: reference - floor };
}

function level(rms: number, scale: ChannelScale | null): number {
  if (!scale) return 0;
  const scaled = (rms - scale.floor) / scale.span;
  return scaled <= 0 ? 0 : scaled >= 1 ? 1 : scaled;
}

// How much of the system signal comes back into the microphone, as a plain RMS ratio.
// Zero whenever the call never plays loudly enough to measure against — including a
// mic-only session, where the system channel is silent by construction.
function estimateEchoCoupling(envelope: SourceEnvelope, systemScale: ChannelScale | null): number {
  if (!systemScale) return 0;
  const frameCount = Math.min(envelope.mic.length, envelope.system.length);
  const ratios: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    const system = envelope.system[i];
    if (system <= 0 || level(system, systemScale) < ECHO_REFERENCE_LEVEL) continue;
    ratios.push(envelope.mic[i] / system);
  }
  if (ratios.length < ECHO_MIN_FRAMES) return 0;
  ratios.sort((a, b) => a - b);
  const index = Math.round(ECHO_QUANTILE * (ratios.length - 1));
  return Math.min(ratios[index], MAX_ECHO_COUPLING);
}

function suppressEcho(envelope: SourceEnvelope, coupling: number): Float32Array {
  if (coupling <= 0) return envelope.mic;
  const out = new Float32Array(envelope.mic.length);
  for (let i = 0; i < out.length; i++) {
    const predicted = coupling * (envelope.system[i] ?? 0);
    out[i] = Math.max(0, envelope.mic[i] - predicted);
  }
  return out;
}

function frameRange(segment: Segment, frameCount: number): [number, number] | null {
  if (segment.start == null || segment.end == null) return null;
  const start = Math.max(0, Math.floor(segment.start / FRAME_SECONDS));
  const end = Math.min(frameCount, Math.ceil(segment.end / FRAME_SECONDS));
  return end > start ? [start, end] : null;
}

// The per-segment verdict, before any speaker consensus. Takes the echo-suppressed mic
// frames rather than the envelope's raw ones — see the header.
function segmentSource(
  segment: Segment,
  micFrames: Float32Array,
  systemFrames: Float32Array,
  micScale: ChannelScale | null,
  systemScale: ChannelScale | null,
): SegmentSource | undefined {
  const frameCount = Math.min(micFrames.length, systemFrames.length);
  const range = frameRange(segment, frameCount);
  if (!range) return undefined;
  const [from, to] = range;

  let micEnergy = 0;
  let systemEnergy = 0;
  for (let i = from; i < to; i++) {
    const mic = level(micFrames[i], micScale);
    const system = level(systemFrames[i], systemScale);
    micEnergy += mic * mic;
    systemEnergy += system * system;
  }

  const total = micEnergy + systemEnergy;
  if (total / (to - from) < MIN_MEAN_ENERGY) return undefined;

  const share = systemEnergy / total;
  if (share >= REMOTE_SHARE) return 'remote';
  if (share <= LOCAL_SHARE) return 'local';
  return 'mixed';
}

// Duration-weighted majority per diarized speaker. 'mixed' segments abstain rather than
// vote: they are the cases where the evidence was ambiguous, and letting them count
// would drag a clear speaker toward the middle.
export function resolveSpeakerSources(segments: Segment[]): Map<string, SegmentSource> {
  const weights = new Map<string, { local: number; remote: number }>();

  for (const segment of segments) {
    if (!segment.speaker || segment.duplicate) continue;
    if (segment.source !== 'local' && segment.source !== 'remote') continue;
    const duration =
      segment.start != null && segment.end != null ? Math.max(0, segment.end - segment.start) : 0;
    const weight = duration > 0 ? duration : FRAME_SECONDS;
    const tally = weights.get(segment.speaker) ?? { local: 0, remote: 0 };
    tally[segment.source] += weight;
    weights.set(segment.speaker, tally);
  }

  const resolved = new Map<string, SegmentSource>();
  for (const [speaker, tally] of weights) {
    const decided = tally.local + tally.remote;
    if (decided <= 0) continue;
    const winner: SegmentSource = tally.remote >= tally.local ? 'remote' : 'local';
    const share = Math.max(tally.local, tally.remote) / decided;
    resolved.set(speaker, share >= CONSENSUS_SHARE ? winner : 'mixed');
  }
  return resolved;
}

// Attribute every segment, then let each speaker's consensus overwrite its own segments.
// The consensus wins on purpose: it is the more reliable of the two readings (see
// header), and a transcript where one line of a speaker reads 'remote' while the rest
// read 'local' is worse than useless to someone scanning who said what.
export function attributeSources(
  segments: Segment[],
  envelope: SourceEnvelope | null | undefined,
): Segment[] {
  if (!envelope || envelope.mic.length === 0 || envelope.system.length === 0) return segments;

  // System first: its calibration is what tells the echo estimate when the call was
  // clearly talking, and unlike the mic it needs no correction of its own.
  const systemScale = calibrate(envelope.system);
  const micFrames = suppressEcho(envelope, estimateEchoCoupling(envelope, systemScale));
  const micScale = calibrate(micFrames);
  if (!micScale && !systemScale) return segments;

  const attributed = segments.map((segment) => {
    const source = segmentSource(segment, micFrames, envelope.system, micScale, systemScale);
    return source ? { ...segment, source } : segment;
  });

  const consensus = resolveSpeakerSources(attributed);
  if (consensus.size === 0) return attributed;

  return attributed.map((segment) => {
    const speakerSource = segment.speaker ? consensus.get(segment.speaker) : undefined;
    return speakerSource && speakerSource !== segment.source
      ? { ...segment, source: speakerSource }
      : segment;
  });
}
