// Finalize a live session: thin composition over the same pipeline leaves the batch
// path uses, with NO re-transcription — the live segments the chunk-queue already
// produced are final. Finalize only adds what needs the whole recording at once:
// speaker labels/overlap from diarization (which reads the saved WAV), whether each
// speaker was in the room or on the call, then analysis.
//
// Two paths, one confirmed scope decision (see plan): when the WAV was saved,
// diarize -> assignSpeakers -> analyze. When saving FAILED (audioPath === null),
// degrade gracefully — skip diarization, deliver the transcript + analysis from the
// already-computed live segments rather than discarding a fully-computed result over
// a disk hiccup. Segments stay speaker-less and the result flags speakersDegraded so
// the UI can surface a non-fatal notice.
//
// The analysis step degrades the same way, for the same reason: a missing API key or
// an unreachable provider used to throw out of here and take an hours-long meeting's
// transcript with it, because only the success path ever reaches saveMeeting. Now the
// failure rides back as analysisError next to an intact transcript. Only a cancel
// (opts.signal) still throws — that one is meant to discard everything.

import { diarize } from '../diarize/diarizer.ts';
import { assignSpeakers } from '../transcribe/align.ts';
import { segmentsToAnalysisText } from '../transcribe/dialogue.ts';
import { flagBoundaryOrphans } from './seam-dedup.ts';
import { attributeSources } from './source-attribution.ts';
import type { SourceEnvelope } from './source-envelope.ts';
import { analyzeText, type Analysis } from '../analyze/analyzer.ts';
import { getLiveConfig, type DiarizationConfig, type MeetingScope } from '../models.ts';
import type { Segment } from '../transcribe/transcriber.ts';

export interface LabelResult {
  segments: Segment[];
  // True only on the degraded (WAV-save-failed) path, where diarization was skipped
  // entirely and segments are speaker-less by necessity — not merely because
  // diarization happened to fail on a valid file (that's the normal fallback).
  speakersDegraded?: boolean;
}

export interface FinalizeResult extends LabelResult {
  // Absent when the analysis step failed. The transcript above is still whole, and it
  // is the expensive half — an unreachable LLM must not cost the user a recorded
  // meeting, so the failure is reported alongside the transcript rather than thrown.
  // Reanalysis (src/main/meeting-reanalysis.ts) fixes it later from the same segments.
  analysis?: Analysis;
  analysisError?: string;
}

export interface FinalizeOptions {
  diarizeTimeoutMs?: number;
  diarizationConfig?: DiarizationConfig;
  includeSpeakersInAnalysis?: boolean;
  // Declared before recording. Only the analysed text reads it — turning diarization off
  // for a two-party meeting is main's job (ipc.ts), decided before the session even starts,
  // so labelSpeakers below stays unaware of it.
  meetingScope?: MeetingScope;
  // Per-source loudness measured while recording, for local/remote attribution. Absent
  // for a batch file, which has no capture sides to tell apart.
  sourceEnvelope?: SourceEnvelope | null;
  // Aborted when the user cancels the meeting: kills the diarizer child process and
  // the in-flight LLM request. Cancellation OUTRANKS the analysis-failure rescue
  // below — a cancelled meeting is discarded whole, transcript included.
  signal?: AbortSignal;
  onPhase?: (phase: 'finalizing' | 'analyzing') => void;
}

// Fixed cost of spawning + tearing down the diarizer child process, added on top of
// the per-second scaling so very short recordings still get breathing room beyond
// raw throughput. Conservative; refine alongside the scale/floor defaults after the
// live benchmark (see getLiveConfig).
const DIARIZE_SPAWN_OVERHEAD_MS = 15_000;

// Duration-aware diarizer timeout: max(floor, duration * scale + spawn overhead).
// scale/floor are env-driven (getLiveConfig); the session passes the result in so
// the diarize call here doesn't need to know the session's sample count.
export function computeDiarizeTimeoutMs(durationMs: number): number {
  const { diarizeTimeoutScale, diarizeTimeoutFloorMs } = getLiveConfig();
  return Math.max(diarizeTimeoutFloorMs, durationMs * diarizeTimeoutScale + DIARIZE_SPAWN_OVERHEAD_MS);
}

// Everything finalize does BEFORE analysis: speaker labels + the cross-round cleanup.
// Split out so the manual test tool can exercise diarization on the real live path
// without paying for an LLM analysis it isn't measuring — finalize() below is still
// the only caller in production, so the two cannot drift.
export async function labelSpeakers(
  liveSegments: Segment[],
  audioPath: string | null,
  opts?: FinalizeOptions,
): Promise<LabelResult> {
  opts?.onPhase?.('finalizing');

  let segments = liveSegments;
  let speakersDegraded = false;

  if (audioPath) {
    // Same fallback shape as batch transcribe(): if diarization is unavailable it
    // returns null and segments stay speaker-less — everything still works.
    const diarization = await diarize(
      audioPath,
      opts?.diarizeTimeoutMs,
      opts?.diarizationConfig,
      opts?.signal,
    );
    segments = diarization ? assignSpeakers(liveSegments, diarization) : liveSegments;
  } else {
    // Degraded path: no WAV on disk to diarize. Keep the live segments as-is
    // (speaker-less) and flag it so the UI can say so.
    speakersDegraded = true;
  }

  // Cross-round cleanup only possible with the whole transcript in hand: drop the
  // truncated boundary fragments the streaming seam pass can't see (a round's tail
  // orphan, subsumed by the next round's fuller re-decode). Left in `segments` but
  // flagged, so segmentsToDialogue excludes them from the LLM text.
  segments = flagBoundaryOrphans(segments);

  // After the speakers and after the orphan flagging, both on purpose: attribution votes
  // per speaker, and a flagged repeat must not get a second vote.
  segments = attributeSources(segments, opts?.sourceEnvelope);

  return { segments, speakersDegraded: speakersDegraded || undefined };
}

export async function finalize(
  liveSegments: Segment[],
  audioPath: string | null,
  opts?: FinalizeOptions,
): Promise<FinalizeResult> {
  const { segments, speakersDegraded } = await labelSpeakers(liveSegments, audioPath, opts);

  const text = segmentsToAnalysisText(
    segments,
    opts?.includeSpeakersInAnalysis ?? true,
    opts?.meetingScope === 'two-party',
  ).trim();
  // Same empty-transcript guard as index.ts's analyze() — e.g. Stop pressed right
  // after Start, before any speech was captured.
  if (text.length === 0) {
    throw new Error('Boş döküm — analiz edilecek metin yok');
  }

  // Nothing below is worth doing for a meeting the user already cancelled — least of
  // all the LLM call. Checked here rather than only inside analyzeText so a cancel
  // landing during diarization never reaches the provider at all.
  opts?.signal?.throwIfAborted();

  opts?.onPhase?.('analyzing');
  try {
    const analysis = await analyzeText(text, { signal: opts?.signal });
    return { segments, analysis, speakersDegraded };
  } catch (e) {
    // A cancel surfaces here as an abort error; it is a discard, not a failed
    // analysis, so it must NOT take the rescue path that saves the transcript.
    opts?.signal?.throwIfAborted();
    return {
      segments,
      speakersDegraded,
      analysisError: e instanceof Error ? e.message : String(e),
    };
  }
}
