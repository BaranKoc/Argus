// Coalescing backpressure over already-decoded PCM for live transcription.
//
// The recorder feeds us PCM in ~chunkSeconds slices via push(). We can't run one
// ASR call per push (they'd overlap and fight for the inference mutex), so we
// coalesce: while a round is decoding, further push()es accumulate and are folded
// into the next round automatically — no dropped audio, no overlapping ASR calls.
//
// Each round prepends ~tailOverlapSeconds of the previous round's tail audio to the
// new pending PCM before decoding. That deliberately re-decodes the boundary so a
// word split across two slices isn't lost — and produces a near-verbatim repeat at
// the seam. Because we prepended exactly tailSamples, we know precisely where the
// seam is, so the repeat is flagged by POSITION (any segment that ENDS inside the
// re-decoded tail is a duplicate by construction) rather than re-detected by
// flagDuplicates()'s text/timing heuristics — those are tuned for the batch 30s/5s
// stitch artifact and miss the short live-seam fragments entirely. See seam-dedup.ts for why we key on the
// segment END, not its midpoint. flagDuplicates() is still run afterward as a
// within-round safety net for any non-seam repeat.
//
// Segment timestamps come back relative to the decoded buffer; we offset them onto
// the session's global timeline using emittedSamples (samples committed so far,
// excluding the re-decoded tail).
//
// The FIRST round is a special case: it has no previous-round tail to prepend, so on
// its own it would decode an isolated ~chunkSeconds opening — too little context for
// Whisper, which can mishear the very first domain terms in live vs. batch. So we hold the first round back until
// firstChunkSeconds of audio has accrued, giving the opening a batch-sized window;
// drain() forces it out early so a session stopped before that threshold still
// flushes. Every later round keeps the smaller chunkSeconds cadence for live latency.

import { transcribeAudio, type Segment } from '../transcribe/transcriber.ts';
import { flagDuplicates } from '../transcribe/dedup.ts';
import { correctSegments } from '../transcribe/correct.ts';
import { flagSeamDuplicates } from './seam-dedup.ts';
import { getLiveConfig, SAMPLE_RATE } from '../models.ts';

export interface ChunkQueueOpts {
  language?: string;
  // Locked for the session by LiveSession.start(). Undefined means the configured
  // default; a foreign-language meeting pins the model that survives forced Turkish.
  modelId?: string;
  onSegments: (newSegments: Segment[]) => void; // fired once per completed round
  // Aborted when the meeting is cancelled. Stops the queue from SCHEDULING further
  // rounds; the ONNX inference already inside transcribeAudio cannot be interrupted,
  // so drain() still waits out at most one round.
  signal?: AbortSignal;
}

// How many previously-emitted segments to hand flagDuplicates as lookback context
// so the first new segment of a round can be compared against the seam. Matches
// dedup.ts's own LOOKBACK.
const DEDUP_CONTEXT = 2;

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class ChunkQueue {
  private readonly language?: string;
  private readonly modelId?: string;
  private readonly onSegments: (segments: Segment[]) => void;
  private readonly signal?: AbortSignal;
  private readonly tailSamples: number;
  // Minimum audio the first round waits to accrue before firing (see header). Later
  // rounds ignore this — they fire as soon as anything is pending.
  private readonly firstChunkSamples: number;
  private hasRunFirstRound = false;

  private pending: Float32Array[] = [];
  // Trailing audio of the previous round, re-decoded at the head of the next round
  // so words spanning the seam aren't cut. Not counted in emittedSamples.
  private tail = new Float32Array(0);
  // Global-timeline sample offset for the next round's NEW audio (excludes tail).
  private emittedSamples = 0;
  // Last few emitted segments, handed to flagDuplicates as dedup lookback context.
  private lastEmitted: Segment[] = [];

  private running = false;
  private loopPromise: Promise<void> = Promise.resolve();

  constructor(opts: ChunkQueueOpts) {
    this.language = opts.language;
    this.modelId = opts.modelId;
    this.onSegments = opts.onSegments;
    this.signal = opts.signal;
    const live = getLiveConfig();
    this.tailSamples = Math.round(live.tailOverlapSeconds * SAMPLE_RATE);
    this.firstChunkSamples = Math.round(live.firstChunkSeconds * SAMPLE_RATE);
  }

  // Accumulate decoded PCM and kick a round if none is in flight. Empty pushes are
  // ignored so a stray zero-length flush can't spin a useless round.
  push(pcm: Float32Array): void {
    if (pcm.length > 0) this.pending.push(pcm);
    this.kick();
  }

  // Resolves once pending is empty AND no round is in flight — the "stop -> drain"
  // guarantee that every recorded sample went through ASR before finalize starts.
  // force so a session stopped before firstChunkSamples has accrued still flushes.
  async drain(): Promise<void> {
    this.kick(true);
    await this.loopPromise;
  }

  // Await any in-flight round WITHOUT forcing a held-back first round out — the manual
  // harness uses this to advance slice-by-slice while still honoring the first-round
  // hold, exactly as the live recorder's push()/kick() would. Real stop() uses drain().
  async settle(): Promise<void> {
    this.kick();
    await this.loopPromise;
  }

  private totalPending(): number {
    return this.pending.reduce((n, c) => n + c.length, 0);
  }

  private kick(force = false): void {
    if (this.running || this.totalPending() === 0) return;
    // Hold the first round back until it has a batch-sized window of audio, unless
    // drain() forces the flush (see header). Later rounds fire immediately.
    if (!force && !this.hasRunFirstRound && this.totalPending() < this.firstChunkSamples) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    try {
      // A round can accrue more pending audio while it decodes; the while re-check
      // folds it into the next round, so drain()'s await sees a truly empty queue.
      // A cancelled meeting drops the backlog instead: nobody will ever read those
      // segments, and each round is a full ASR pass.
      while (this.totalPending() > 0 && !this.signal?.aborted) {
        await this.runRound();
      }
    } finally {
      this.running = false;
    }
  }

  private async runRound(): Promise<void> {
    const fresh = mergeChunks(this.pending);
    this.pending = [];

    const buffer = concat(this.tail, fresh);
    // The buffer starts tail.length samples before the next committed sample.
    const offsetSec = (this.emittedSamples - this.tail.length) / SAMPLE_RATE;

    const raw = await transcribeAudio(buffer, { language: this.language, modelId: this.modelId });
    const offset = raw.map((s) => ({
      ...s,
      start: s.start != null ? s.start + offsetSec : null,
      end: s.end != null ? s.end + offsetSec : null,
    }));
    // Correct known domain-term misspellings before dedup, so consistent spelling
    // also improves repeat-matching.
    const corrected = correctSegments(offset);

    // Flag the seam repeat by position — fresh audio starts at emittedSamples on the
    // global timeline (before the increment below).
    const positioned = flagSeamDuplicates(corrected, this.emittedSamples / SAMPLE_RATE);

    // Belt-and-suspenders: run the shared dedup for any non-seam within-round repeat.
    // Prepend prior context, then keep only this round's segments.
    const combined = flagDuplicates([...this.lastEmitted, ...positioned]);
    const flagged = combined.slice(this.lastEmitted.length);

    // Commit: the fresh audio joins the timeline; the tail becomes the last
    // tailSamples of what we just decoded so the next round can re-decode the seam.
    // Copy into a fresh array (not a slice view) so it stays plain-ArrayBuffer-backed.
    this.emittedSamples += fresh.length;
    this.hasRunFirstRound = true;
    const tailStart = Math.max(0, buffer.length - this.tailSamples);
    const tail = new Float32Array(buffer.length - tailStart);
    tail.set(buffer.subarray(tailStart));
    this.tail = tail;
    if (flagged.length > 0) this.lastEmitted = flagged.slice(-DEDUP_CONTEXT);

    if (flagged.length > 0) this.onSegments(flagged);
  }
}
