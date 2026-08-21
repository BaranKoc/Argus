// Whisper ASR as a warm, module-level singleton (see architecture doc §2).
// The expensive part of speech-to-text is loading the model; we pay it once,
// lazily, and reuse the pipeline for every subsequent call.

import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { getConfig, SAMPLE_RATE } from '../models.ts';
import { loadAudio } from './audio.ts';
import { findSpeechBounds, hasSpeech } from './vad.ts';

export interface Segment {
  start: number | null;
  end: number | null;
  text: string;
  // Speaker label (e.g. 'SPEAKER_00') attached by the diarizer via align.ts.
  // Absent when diarization is disabled/unavailable or the segment has no
  // timestamps to align against.
  speaker?: string;
  // Chunk-boundary stitch artifact: this segment's text repeats the preceding
  // one (Transformers.js merges the 30s window / 5s stride overlap imperfectly).
  // Set by flagDuplicates (dedup.ts). Flagged, not removed — kept for auditability
  // but excluded from the joined LLM text (see index.ts).
  duplicate?: boolean;
  // Simultaneous-speech / crosstalk proxy: this segment spans >=2 distinct speaker
  // turns meaningfully (see align.ts). Not literal overlapping energy — sherpa's
  // turns are time-exclusive — but marks where turns collapse into one segment.
  overlap?: boolean;
  // Which capture side the voice came from in a live recording: 'local' = the room's
  // microphone, 'remote' = the call's system audio, 'mixed' = both at once. Set by
  // live/source-attribution.ts; absent for batch files, for mic-only sessions with no
  // system capture, and wherever the evidence was too faint to place.
  source?: 'local' | 'remote' | 'mixed';
}

export interface TranscribeOpts {
  language?: string;
  // Which Whisper weights to decode with. Omitted means the configured default
  // (Turkish); a foreign-language meeting passes the model models.ts maps it to.
  modelId?: string;
}

// --- Warm model cache -----------------------------------------------------
// Keyed, not a bare singleton: a foreign-language meeting decodes with a different
// model, and warmUp() has already resolved the default one by the time the user picks.
// A plain `if (!asrPromise)` would therefore never re-evaluate and the choice would
// silently transcribe with the wrong model — no error anywhere.
//
// One entry, not a Map: holding two Whisper models resident doubles the footprint for
// no benefit, since a meeting decodes with exactly one of them from start to finish.
// Switching languages between meetings pays a reload, which is the right trade.
let asrKey: string | null = null;
let asrPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getAsr(modelId?: string): Promise<AutomaticSpeechRecognitionPipeline> {
  const config = getConfig();
  const model = modelId ?? config.modelId;
  const key = `${model}|${config.device}|${JSON.stringify(config.dtype)}`;
  if (asrKey !== key || !asrPromise) {
    asrKey = key;
    asrPromise = pipeline('automatic-speech-recognition', model, {
      device: config.device,
      dtype: config.dtype,
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
  }
  return asrPromise;
}

// Optional warm-up hook: the UI can call this at app start so the first real
// transcription is not the one that pays the model-load latency. Warms the default
// (Turkish) model — the foreign one loads on demand, since most meetings never need it.
export function warmUp(): Promise<unknown> {
  return getAsr();
}

// --- Serialize inference --------------------------------------------------
// One model instance, CPU/GPU-bound -> run inferences one at a time. This is a
// mutex around the singleton, not a request protocol (doc §5.3).
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // Keep the chain alive even if a task rejects, without unhandled-rejection noise.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

// --- Public transcribe ----------------------------------------------------
// Convenience wrapper: decode the file, then transcribe. index.ts uses
// transcribeAudio directly so it can share one decode with the diarizer.
export async function transcribe(
  audioPath: string,
  opts: TranscribeOpts = {},
): Promise<Segment[]> {
  const audio = await loadAudio(audioPath);
  return transcribeAudio(audio, opts);
}

// Raw per-chunk shape Whisper returns when return_timestamps is on.
type RawChunk = { timestamp: [number | null, number | null]; text: string };

// Normalize one pipeline result into Segments, offsetting every timestamp by
// `offset` seconds (0 for chunked; the window start for sequential). Returns a
// single untimed segment when the model gave no chunks (short/quiet clip).
function toSegments(result: unknown, offset = 0): Segment[] {
  const output = Array.isArray(result) ? result[0] : result;
  const chunks = (output as { chunks?: RawChunk[] }).chunks;

  if (chunks && chunks.length > 0) {
    return chunks.map((c) => ({
      start: c.timestamp?.[0] != null ? c.timestamp[0] + offset : null,
      end: c.timestamp?.[1] != null ? c.timestamp[1] + offset : null,
      text: c.text,
    }));
  }

  return [{ start: null, end: null, text: (output as { text: string }).text }];
}

// Transcribe already-decoded 16 kHz mono PCM (see audio.ts). Kept separate from
// transcribe() so a single decode can feed both this and the diarizer.
export async function transcribeAudio(
  audio: Float32Array,
  opts: TranscribeOpts = {},
): Promise<Segment[]> {
  const asr = await getAsr(opts.modelId);
  const { mode, vad } = getConfig();
  // Turkish is forced on BOTH models: the foreign path changes which weights decode the
  // audio, never the output language. The whole feature is "a foreign meeting still
  // produces a Turkish transcript".
  const language = opts.language ?? 'tr';

  // Keep speech-free audio away from the decoder: Whisper answers silence with a
  // hallucinated caption ("Altyazı M.K."), so an all-silent file must not be
  // decoded at all and a silent lead-in must not be decoded as a chunk of its
  // own. Only the head and tail are trimmed — silence BETWEEN utterances decodes
  // fine today and is left exactly as it was — which keeps the correction to a
  // single constant offset back onto the original timeline.
  let speech = audio;
  let offset = 0;
  if (vad) {
    const bounds = findSpeechBounds(audio);
    if (!bounds) return [];
    speech = audio.subarray(bounds.start, bounds.end);
    offset = bounds.start / SAMPLE_RATE;
  }

  // One enqueue() task holds the inference mutex for the whole call, so the
  // sequential loop's windows run back-to-back without other requests interleaving.
  return enqueue(async () => {
    if (mode === 'sequential') {
      return transcribeSequential(asr, speech, language, offset, vad);
    }

    // Chunked (default): fixed 30s windows with 5s overlap, emitting per-chunk
    // timestamps so we get WhisperX-style {start, end, text} segments.
    const result = await asr(speech, {
      language,
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    return toSegments(result, offset);
  });
}

// Hand-rolled sequential long-form: Transformers.js has no native sequential
// algorithm (omitting chunk_length_s just truncates to the first 30s), so we
// slide a 30s window ourselves. Each window is <=30s, so we call the pipeline
// WITHOUT chunk_length_s (no truncation), then advance the window to where the
// last predicted timestamp ended — boundaries land on natural pauses instead of
// a fixed grid. Runs strictly serially; caller already holds the inference mutex.
const WINDOW_SAMPLES = 30 * SAMPLE_RATE;

async function transcribeSequential(
  asr: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
  language: string,
  offset: number,
  vad: boolean,
): Promise<Segment[]> {
  const out: Segment[] = [];
  let seek = 0;

  while (seek < audio.length) {
    const window = audio.subarray(seek, seek + WINDOW_SAMPLES);
    const base = offset + seek / SAMPLE_RATE;

    // A window with no speech in it is the ghost-caption case in miniature: head
    // and tail are already trimmed, but a long silence mid-meeting can still fill
    // a whole window. Skip it without decoding — there is no timestamp to seek by
    // either, so hop the full window.
    if (vad && !hasSpeech(window)) {
      seek += WINDOW_SAMPLES;
      continue;
    }

    const result = await asr(window, { language, return_timestamps: true });
    const segments = toSegments(result, base);
    out.push(...segments);

    // Advance to the last predicted end (relative to this window). Fall back to a
    // full-window hop when there is no usable timestamp, and guard against a hop
    // of zero so the loop can never stall.
    const lastEnd = segments.at(-1)?.end;
    const relEnd = lastEnd != null ? lastEnd - base : null;
    let next =
      relEnd != null && relEnd > 0 && Number.isFinite(relEnd)
        ? seek + Math.round(relEnd * SAMPLE_RATE)
        : seek + WINDOW_SAMPLES;
    if (next <= seek) next = seek + WINDOW_SAMPLES;
    seek = next;
  }

  return out;
}
