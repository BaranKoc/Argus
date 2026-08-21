// Public engine API (architecture doc §5.1). The frontend imports these plain
// async functions directly — no subprocess, no ports, no pipes.

import fs from 'node:fs/promises';
import { transcribeAudio, warmUp as warmTranscriber, type Segment, type TranscribeOpts } from './transcribe/transcriber.ts';
import { diarize, warmUp as warmDiarizer } from './diarize/diarizer.ts';
import { assignSpeakers } from './transcribe/align.ts';
import { flagDuplicates } from './transcribe/dedup.ts';
import { correctSegments } from './transcribe/correct.ts';
import { loadAudio } from './transcribe/audio.ts';
import { analyzeText, type Analysis, type AnalyzeOpts } from './analyze/analyzer.ts';
import { segmentsToDialogue } from './transcribe/dialogue.ts';
import { modelForLanguage, type MeetingLanguage } from './models.ts';

export type { Segment, TranscribeOpts, Analysis, AnalyzeOpts };
export {
  ANALYSIS_SECTIONS,
  EMPTY_SECTION_TEXT,
  emptyAnalysisDraft,
  parseAnalysisMarkdown,
  serializeAnalysisMarkdown,
  type AnalysisDraft,
  type AnalysisSectionKey,
} from './analyze/sections.ts';

// segmentsToDialogue moved to transcribe/dialogue.ts so the live seam can reuse it
// without cycling back through this module. Re-exported here so every existing
// importer (bench/worker.ts, test/*) is unaffected.
export {
  segmentsToDialogue,
  segmentsToTranscriptText,
  segmentsToSideDialogue,
} from './transcribe/dialogue.ts';
export {
  liveSession,
  type LiveState,
  type LiveStatusEvent,
  type LiveSegmentsEvent,
  type LiveResultEvent,
  type LiveErrorEvent,
} from './live/session.ts';
// The renderer's chunk cadence must match the engine's — expose the live config
// through the same index.ts boundary src/ uses for everything else.
export { getLiveConfig, configureDiarization, type LiveConfig, type DiarizationConfig } from './models.ts';
// The recording screen picks the meeting language and main forwards it; both need the
// type, and neither should learn which Whisper weights it maps to.
export { type MeetingLanguage, DEFAULT_MEETING_LANGUAGE } from './models.ts';
// Same shape as the language above: declared on the recording screen, forwarded by main,
// and neither of them needs to know what it does to the pipeline.
export { type MeetingScope, DEFAULT_MEETING_SCOPE } from './models.ts';
export { type LiveStartOptions } from './live/session.ts';
// The app installs the analysis model the same way it installs the diarization config —
// through this boundary, never by reaching into models.ts. main/index.ts calls this at
// boot with the user's saved setting, which is what makes .env irrelevant in the app.
export { configureLlm, getLlmRuntimeConfig, type LlmRuntimeConfig } from './models.ts';

export interface Transcript {
  status: 'success';
  segments: Segment[];
}

// Warm up both the ASR pipeline and the diarizer so the first real request
// doesn't pay their load latency. Diarizer warm-up is best-effort (never throws).
export function warmUp(): Promise<unknown> {
  return Promise.all([warmTranscriber(), warmDiarizer()]);
}

// Speech-to-text with speaker labels: audio file path in, transcript out.
// Whisper decodes the file in-process and transcribes; the diarizer runs in a
// separate child process (see diarizer.ts — it must not share the ONNX Runtime
// DLL with Whisper) and re-decodes from the path there, concurrently and cheaply.
// align.ts then joins the two. If diarization is unavailable, segments come back
// speaker-less and everything still works.
export interface TranscribeRequest extends TranscribeOpts {
  // What the meeting is held in. The batch path takes it so the CLI, the bench and the
  // manual tool can exercise the foreign-language model the same way a recording does.
  meetingLanguage?: MeetingLanguage;
}

export async function transcribe(audioPath: string, opts?: TranscribeRequest): Promise<Transcript> {
  const audio = await loadAudio(audioPath);
  // An explicit modelId still wins — it is the low-level knob the live queue threads —
  // but callers normally say what the meeting is and let the engine choose.
  const rawSegments = await transcribeAudio(audio, {
    ...opts,
    modelId: opts?.modelId ?? modelForLanguage(opts?.meetingLanguage),
  });
  // Correct known domain-term misspellings before dedup, so consistent spelling
  // also improves repeat-matching.
  const corrected = correctSegments(rawSegments);
  // Mark chunk-boundary stitch repeats before diarization; they stay in the array
  // (auditability) but are dropped from the joined text below.
  const segments = flagDuplicates(corrected);
  // Diarization is the signal behind BOTH speaker labels and the `overlap` flag, and
  // it self-disables when the app hasn't enabled it (diarizer.ts returns null), so no
  // gate is needed here. Labels are kept whenever they exist: segmentsToDialogue falls
  // back to plain text when no segment carries a speaker.
  const diarization = await diarize(audioPath);
  const labelled = diarization ? assignSpeakers(segments, diarization) : segments;
  return { status: 'success', segments: labelled };
}

// App-facing endpoint (the "metne çevir" action): audio file path in, plain text out.
// Reads the given path, transcribes, and returns the joined text. Keeps no record —
// nothing is written to output/, so the audio stays temporary and the caller owns its
// lifecycle (see removeAudio).
export async function transcribeToText(audioPath: string, opts?: TranscribeOpts): Promise<string> {
  const { segments } = await transcribe(audioPath, opts);
  return segmentsToDialogue(segments);
}


// Analysis (canonical nine-section Markdown) via an LLM — a local Ollama by default,
// or whichever provider ENGINE_LLM_PROVIDER names. Accepts either the plain transcript
// text or a Transcript envelope; normalizes to text and delegates to the analyzer,
// which picks the provider adapter per call (see analyzer.ts, analyze/llm/index.ts).
// The Analysis / AnalyzeOpts types are defined there and re-exported above.
export async function analyze(
  transcript: string | Transcript,
  opts?: AnalyzeOpts,
): Promise<Analysis> {
  const text = (
    typeof transcript === 'string' ? transcript : segmentsToDialogue(transcript.segments)
  ).trim();

  if (text.length === 0) {
    throw new Error('Boş döküm — analiz edilecek metin yok');
  }

  return analyzeText(text, opts);
}
