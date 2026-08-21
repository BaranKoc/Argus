// Live-recording session: a module-level singleton state machine, the orchestration
// seam between streaming IPC (src/main/ipc.ts) and the pipeline leaves. Single
// singleton, no session-ID abstraction — same pattern as transcriber.ts's getAsr
// singleton and temp.ts's tracked Set, because this app is single-window.
//
//   idle → recording ⇄ paused → finalizing → analyzing → done   (+ error)
//                                    └── cancel() ──→ idle ('cancelled')
//
// It owns a ChunkQueue during recording (each round emits a 'segments' delta and is
// accumulated here), and on stop() drains the queue, runs finalize(), and emits the
// terminal 'result'. It never deletes audio — that's app policy, sequenced in ipc.ts
// after 'result' so the KVKK "auto-deleted" claim is true by construction.
//
// Exactly ONE terminal event per meeting — 'result', 'error' or 'cancelled' — because
// 'result' is what makes a meeting exist on disk (ipc.ts is the only caller of
// saveMeeting) and a second event could either save a discarded meeting or discard a
// saved one.

import { EventEmitter } from 'node:events';
import { ChunkQueue } from './chunk-queue.ts';
import { finalize, computeDiarizeTimeoutMs } from './finalize.ts';
import {
  appendEnvelopeFrames,
  type EnvelopeTimeline,
  type SourceEnvelope,
} from './source-envelope.ts';
import {
  modelForLanguage,
  SAMPLE_RATE,
  DEFAULT_MEETING_SCOPE,
  type MeetingLanguage,
  type MeetingScope,
} from '../models.ts';
import { getDiarizationConfig, type DiarizationConfig } from '../models.ts';
import type { Segment, TranscribeOpts } from '../transcribe/transcriber.ts';
import type { Analysis } from '../analyze/analyzer.ts';

export type LiveState =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'analyzing'
  | 'done'
  | 'error';

export interface LiveStatusEvent {
  state: LiveState;
  detail?: string;
}
export interface LiveSegmentsEvent {
  segments: Segment[];
}
export interface LiveResultEvent {
  segments: Segment[];
  // Absent when only the analysis failed — the meeting is still a result, not an
  // error, because the transcript is worth keeping and reanalysis can fill this in
  // later. See finalize.ts's header for why the failure is not thrown.
  analysis?: Analysis;
  analysisError?: string;
  speakersDegraded?: boolean;
  // Echoed back so whoever persists the meeting records how it was analysed without
  // keeping its own copy of what was passed to start() — one source of truth per meeting.
  meetingScope: MeetingScope;
}
export interface LiveErrorEvent {
  message: string;
  phase: 'finalizing' | 'analyzing';
}

export interface LiveStartOptions extends TranscribeOpts {
  includeSpeakersInAnalysis?: boolean;
  // Chosen on the recording screen before the meeting starts. Semantic on purpose: the
  // caller says what the meeting is, the engine decides which weights that implies.
  meetingLanguage?: MeetingLanguage;
  // Same contract for the other pre-meeting declaration: the caller says how many parties
  // are in the room, the engine decides what that means for the analysed text.
  meetingScope?: MeetingScope;
}

class LiveSession extends EventEmitter {
  private state: LiveState = 'idle';
  private queue: ChunkQueue | null = null;
  // Every segment emitted across all rounds, in order — the full transcript finalize
  // works from (live segments remain final; finalize never re-transcribes).
  private segments: Segment[] = [];
  // Total samples pushed while recording — the recording's true duration, used to
  // size the diarizer timeout without a second decode.
  private cumulativeSamples = 0;
  // Per-source loudness for the whole recording, one entry per envelope frame, on the
  // same sample timeline as cumulativeSamples.
  private envelope: EnvelopeTimeline = { mic: [], system: [] };
  private diarizationConfig: DiarizationConfig | null = null;
  private includeSpeakersInAnalysis = true;
  private meetingScope: MeetingScope = DEFAULT_MEETING_SCOPE;
  // One controller per session (the ChunkQueue needs it from start()), but cancel()
  // only honours it during finalizing/analyzing: before Stop the user simply doesn't
  // press it, and after 'result' the meeting is already saved, where the Dashboard's
  // delete is the way out.
  private abort: AbortController | null = null;
  private cancelled = false;

  start(opts?: LiveStartOptions): void {
    this.segments = [];
    this.cumulativeSamples = 0;
    this.envelope = { mic: [], system: [] };
    this.cancelled = false;
    this.abort = new AbortController();
    this.diarizationConfig = getDiarizationConfig();
    this.includeSpeakersInAnalysis = opts?.includeSpeakersInAnalysis ?? true;
    // Snapshotted for the same reason as diarizationConfig: what the meeting IS was
    // decided before it started, and nothing mid-recording may change that answer.
    this.meetingScope = opts?.meetingScope ?? DEFAULT_MEETING_SCOPE;
    // Resolved once, at start: the model is locked for the whole meeting, so a config
    // change mid-recording cannot make round 12 decode with different weights than
    // round 1 — the same reason diarizationConfig is snapshotted above.
    this.queue = new ChunkQueue({
      language: opts?.language,
      modelId: modelForLanguage(opts?.meetingLanguage),
      signal: this.abort.signal,
      onSegments: (delta) => {
        this.segments.push(...delta);
        this.emit('segments', { segments: delta } satisfies LiveSegmentsEvent);
      },
    });
    this.setState('recording');
  }

  pushChunk(pcm: Float32Array, envelope?: SourceEnvelope): void {
    if (this.state !== 'recording' || !this.queue) return;
    if (envelope) appendEnvelopeFrames(this.envelope, this.cumulativeSamples, envelope);
    this.cumulativeSamples += pcm.length;
    this.queue.push(pcm);
  }

  pause(): void {
    if (this.state === 'recording') this.setState('paused');
  }

  resume(): void {
    if (this.state === 'paused') this.setState('recording');
  }

  // Drain every recorded sample through ASR, then finalize (diarize + analyze) and
  // emit 'result'. audioPath === null is the degraded path (WAV save failed): finalize
  // skips diarization and the result carries speakersDegraded.
  async stop(audioPath: string | null): Promise<void> {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    this.setState('finalizing');

    let phase: 'finalizing' | 'analyzing' = 'finalizing';
    try {
      await this.queue!.drain();
      const durationMs = (this.cumulativeSamples / SAMPLE_RATE) * 1000;
      const result = await finalize(this.segments, audioPath, {
        diarizeTimeoutMs: computeDiarizeTimeoutMs(durationMs),
        diarizationConfig: this.diarizationConfig ?? undefined,
        includeSpeakersInAnalysis: this.includeSpeakersInAnalysis,
        meetingScope: this.meetingScope,
        sourceEnvelope: this.sourceEnvelope(),
        signal: this.abort?.signal,
        onPhase: (p) => {
          phase = p;
          this.setState(p);
        },
      });
      // A cancel that lands while the last stage is still running still wins: the
      // work is done but nobody wants it, and emitting 'result' here would save it.
      if (this.cancelled) {
        this.finishCancelled();
        return;
      }
      // Terminal success emits ONLY 'result' — no 'status:done'. ipc.ts deletes the
      // temp audio on 'result' before forwarding it to the renderer, and a racing
      // 'status:done' would let the UI claim deletion before it happened.
      this.state = 'done';
      this.emit('result', {
        segments: result.segments,
        analysis: result.analysis,
        analysisError: result.analysisError,
        speakersDegraded: result.speakersDegraded,
        meetingScope: this.meetingScope,
      } satisfies LiveResultEvent);
    } catch (e) {
      // An abort error is the cancel arriving, not a failure — reporting it as one
      // would put a red "Hata" on a screen the user deliberately dismissed.
      if (this.cancelled) {
        this.finishCancelled();
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.setState('error', message);
      this.emit('error', { message, phase } satisfies LiveErrorEvent);
    } finally {
      this.queue = null;
      this.abort = null;
      this.cancelled = false;
      this.diarizationConfig = null;
      this.includeSpeakersInAnalysis = true;
      this.meetingScope = DEFAULT_MEETING_SCOPE;
      this.envelope = { mic: [], system: [] };
    }
  }

  // Discard the meeting currently being finalized: kill the diarizer child process,
  // stop scheduling ASR rounds, abort the LLM request. Emits NOTHING itself — the
  // terminal event is always stop()'s to emit, so a session can never produce both a
  // 'cancelled' and a 'result' for the same meeting no matter when the cancel lands.
  cancel(): void {
    if (this.state !== 'finalizing' && this.state !== 'analyzing') return;
    this.cancelled = true;
    this.abort?.abort();
  }

  private finishCancelled(): void {
    // Straight back to idle: a cancelled meeting leaves nothing to look at, so there
    // is no terminal state for the UI to sit in.
    this.setState('idle');
    this.emit('cancelled');
  }

  private sourceEnvelope(): SourceEnvelope | null {
    if (this.envelope.mic.length === 0) return null;
    return {
      mic: Float32Array.from(this.envelope.mic),
      system: Float32Array.from(this.envelope.system),
    };
  }

  private setState(state: LiveState, detail?: string): void {
    this.state = state;
    this.emit('status', { state, detail } satisfies LiveStatusEvent);
  }
}

export const liveSession = new LiveSession();
