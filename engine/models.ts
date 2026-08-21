// Central model + hardware configuration for the Node engine.
//
// This replaces the old Python WHISPERX_* environment variables:
//   WHISPERX_MODEL   -> ENGINE_MODEL   (now an ONNX model id, not a faster-whisper name)
//   WHISPERX_DEVICE  -> ENGINE_DEVICE  (cpu | cuda | webgpu)
//   WHISPERX_COMPUTE -> ENGINE_DTYPE   (fp32 | fp16 | q8 | q4)
//
// Note: the old cached models under ~/.cache/huggingface/hub are CTranslate2
// (faster-whisper) weights and CANNOT be used here. Transformers.js/ONNX Runtime
// needs ONNX weights (e.g. onnx-community/whisper-medium), which the
// download-models tool fetches once into the local models/ folder below.

import { env } from '@huggingface/transformers';
import {
  MODELS_DIR,
  SAMPLE_RATE,
  getDiarizationConfig,
  configureDiarization,
  type DiarizationConfig,
} from './diarization-config.ts';
import {
  DEFAULT_PRESET_ID,
  LLM_PROVIDERS,
  PROVIDER_DEFAULTS,
  envApiKeyFor,
  presetOrDefault,
  type LlmProvider,
} from './analyze/llm/catalog.ts';

// MODELS_DIR / SAMPLE_RATE and all diarization config live in the transformers-free
// leaf (diarization-config.ts) so the diarization worker can share them without
// loading @huggingface/transformers. Re-exported here for existing importers
// (download-models.ts) that already legitimately load transformers.
export { MODELS_DIR, SAMPLE_RATE, getDiarizationConfig, configureDiarization };
export type { DiarizationConfig };

// Point Transformers.js at the local models/ cache and keep it fully offline by
// default, so the app never re-downloads on the slow office connection. Set
// ENGINE_ALLOW_DOWNLOAD=1 (used by download-models.ts) to permit fetching.
env.cacheDir = MODELS_DIR;
const allowDownload = process.env.ENGINE_ALLOW_DOWNLOAD === '1';
env.allowRemoteModels = allowDownload;
env.allowLocalModels = true;

export type Device = 'cpu' | 'cuda' | 'webgpu';
export type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4';

// Transformers.js accepts EITHER one dtype for the whole model, OR a per-sub-model
// map. Whisper's sub-models are `encoder_model` and `decoder_model_merged`. Split
// dtype matters for turbo: its encoder is big + q8-tolerant, its decoder is small +
// q8-sensitive (only 4 layers), so `encoder=q8,decoder=fp32` is the interesting mix.
export type DtypeMap = Partial<Record<'encoder_model' | 'decoder_model_merged', Dtype>>;

const DTYPES = new Set<Dtype>(['fp32', 'fp16', 'q8', 'q4']);

function asDtype(token: string): Dtype {
  if (DTYPES.has(token as Dtype)) return token as Dtype;
  throw new Error(`Geçersiz dtype "${token}". İzin verilenler: ${[...DTYPES].join(', ')}.`);
}

// Parse ENGINE_DTYPE into what Transformers.js wants. Pure — no env, no I/O — so it
// unit-tests without a model. Scalar ("q8") stays scalar (backward compatible);
// "encoder=q8,decoder=fp32" becomes { encoder_model, decoder_model_merged }. This is
// the single parser shared by getConfig/getAsr and download-models/check-models so a
// dtype can't be downloaded under one interpretation and run under another.
export function parseDtype(input: string): Dtype | DtypeMap {
  const raw = input.trim();
  if (!raw) throw new Error('Boş dtype.');
  if (!raw.includes('=')) return asDtype(raw);

  const map: DtypeMap = {};
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (!k || !v) {
      throw new Error(`Geçersiz split dtype parçası "${part}". Biçim: encoder=q8,decoder=fp32.`);
    }
    const key = k.toLowerCase();
    if (key === 'encoder' || key === 'encoder_model') map.encoder_model = asDtype(v);
    else if (key === 'decoder' || key === 'decoder_model_merged') map.decoder_model_merged = asDtype(v);
    else throw new Error(`Bilinmeyen alt-model "${k}". Kullan: encoder / decoder.`);
  }
  if (!map.encoder_model && !map.decoder_model_merged) throw new Error(`Split dtype boş: "${raw}".`);
  return map;
}

// Long-form decoding strategy:
//   'chunked'    - fixed 30s windows with 5s overlap, decoded independently and
//                  stitched (Transformers.js native, fast, parallelizable).
//   'sequential' - hand-rolled sliding 30s window that advances to the last
//                  predicted timestamp (boundaries fall on natural pauses).
//                  See transcriber.ts. Slower but no overlap-boundary artifacts.
export type TranscribeMode = 'chunked' | 'sequential';

// Which language the meeting is held in, as chosen on the recording screen before the
// meeting starts. It selects a MODEL, not a decode language: the decoder is forced to
// Turkish either way, because the product only ever produces Turkish transcripts.
export type MeetingLanguage = 'turkish' | 'foreign';

export const DEFAULT_MEETING_LANGUAGE: MeetingLanguage = 'turkish';

// How many parties are in the meeting, declared on the recording screen before it starts.
// 'two-party' is a claim about the room, not a setting: with exactly two sides, the capture
// side IS the speaker, so diarization has nothing left to separate and the local/remote
// labels can stand in for speaker labels all the way into the analysis. Anything more and
// that stops being true — two people on the far end would collapse into one "Uzak
// Konuşmacı" — which is why this is declared rather than inferred.
export type MeetingScope = 'group' | 'two-party';

export const DEFAULT_MEETING_SCOPE: MeetingScope = 'group';

export interface EngineConfig {
  modelId: string;
  // Model used when the meeting is NOT in Turkish. turbo's distilled 4-layer decoder
  // collapses into a repetition loop when the forced language does not match the audio
  // ("Bu konuda, herkese birçok." to the end of the recording), while medium's full
  // decoder produces a rough but genuine Turkish rendering of foreign speech. Measured
  // in docs/multilingual-transcription.md.
  foreignModelId: string;
  device: Device;
  dtype: Dtype | DtypeMap;
  mode: TranscribeMode;
  // Skip speech-free audio instead of decoding it (transcribe/vad.ts). ON by
  // default; ENGINE_VAD=0 restores the un-filtered behaviour, which is worth
  // having when a transcript comes back suspiciously short and you need to know
  // whether the VAD ate it.
  vad: boolean;
  // Correct known domain-term misspellings (transcribe/correct.ts) before dedup
  // runs. ON by default; ENGINE_DICTIONARY=0 disables it for A/B comparison.
  dictionary: boolean;
}

// Whisper ONNX model id. whisper-large-v3-turbo is the default: on our benchmark it
// fixed the code-switching / domain-term corruption medium showed (see
// docs/model-selection.md) at ~medium's resource footprint. Fully supports
// Turkish; the onnx-community repo carries every quantization (q8/fp16/q4/...) as ONNX weights.
const DEFAULT_MODEL = 'onnx-community/whisper-large-v3-turbo';

// Only ever reached when the user marks the meeting as foreign. medium loses to turbo on
// Turkish (20/38 vs 26/38 fixed-term recall in the full-matrix run) which is exactly why
// it is NOT the default — but it is the one that survives a forced language mismatch.
// Shipped quantized-only, so this path always runs q8.
const DEFAULT_FOREIGN_MODEL = 'onnx-community/whisper-medium-ONNX';

// CPU default so it works everywhere out of the box. CUDA is opt-in and requires
// the GPU build of onnxruntime-node; webgpu is available in supported runtimes.
const DEFAULT_DEVICE: Device = 'cpu';

// q8 keeps CPU inference fast and memory-light while staying accurate enough for
// meeting audio. fp16 is a good choice on GPU.
const DEFAULT_DTYPE: Dtype = 'q8';

// Chunked is the proven default; sequential is opt-in via ENGINE_TRANSCRIBE_MODE.
const DEFAULT_MODE: TranscribeMode = 'chunked';

export function getConfig(): EngineConfig {
  return {
    modelId: process.env.ENGINE_MODEL || DEFAULT_MODEL,
    foreignModelId: process.env.ENGINE_MODEL_FOREIGN || DEFAULT_FOREIGN_MODEL,
    device: (process.env.ENGINE_DEVICE as Device) || DEFAULT_DEVICE,
    dtype: parseDtype(process.env.ENGINE_DTYPE || DEFAULT_DTYPE),
    mode: (process.env.ENGINE_TRANSCRIBE_MODE as TranscribeMode) || DEFAULT_MODE,
    vad: process.env.ENGINE_VAD !== '0',
    dictionary: process.env.ENGINE_DICTIONARY !== '0',
  };
}

// The one place a meeting language becomes a model id. Renderer and main carry only the
// semantic choice; which weights that implies is the engine's business, so a model swap
// never has to touch the IPC contract or the UI.
export function modelForLanguage(language: MeetingLanguage = DEFAULT_MEETING_LANGUAGE): string {
  const config = getConfig();
  return language === 'foreign' ? config.foreignModelId : config.modelId;
}

// --- Live recording ---------------------------------------------------------
// Configuration for the live-recording seam (engine/live/). The recorder emits
// PCM in ~chunkSeconds slices; each ASR round prepends tailOverlapSeconds of the
// previous round's audio so word boundaries aren't cut, and dedup.ts strips the
// deliberate repeat. The diarize timeout at finalize is duration-aware:
// max(floorMs, durationMs * scale + spawn overhead) — scale/floor are conservative
// defaults with no in-repo throughput measurement yet to derive them from (tune
// after the live benchmark). Follows the ENGINE_* + default-constant convention.
export interface LiveConfig {
  chunkSeconds: number;
  firstChunkSeconds: number;
  tailOverlapSeconds: number;
  diarizeTimeoutScale: number;
  diarizeTimeoutFloorMs: number;
}

const DEFAULT_LIVE_CHUNK_SECONDS = 8;
// The first round has no previous-round tail to prepend for context, so on its own
// it decodes an isolated ~chunkSeconds opening — too little for Whisper to lock onto
// domain terms, which can be misheard in an isolated live opening. Holding the first round back until this
// much audio has accrued gives the opening a batch-sized window; later rounds keep
// the smaller chunkSeconds cadence for live latency.
const DEFAULT_LIVE_FIRST_CHUNK_SECONDS = 20;
const DEFAULT_LIVE_TAIL_OVERLAP_SECONDS = 1.5;
const DEFAULT_LIVE_DIARIZE_TIMEOUT_SCALE = 1.5;
// 10 min floor — the same conservative ceiling the batch diarizer used before the
// timeout became duration-aware.
const DEFAULT_LIVE_DIARIZE_TIMEOUT_FLOOR_MS = 600_000;

export function getLiveConfig(): LiveConfig {
  return {
    chunkSeconds: parseNumberEnv('ENGINE_LIVE_CHUNK_SECONDS', DEFAULT_LIVE_CHUNK_SECONDS, 1),
    firstChunkSeconds: parseNumberEnv(
      'ENGINE_LIVE_FIRST_CHUNK_SECONDS',
      DEFAULT_LIVE_FIRST_CHUNK_SECONDS,
      1,
    ),
    tailOverlapSeconds: parseNumberEnv(
      'ENGINE_LIVE_TAIL_OVERLAP_SECONDS',
      DEFAULT_LIVE_TAIL_OVERLAP_SECONDS,
      0,
    ),
    diarizeTimeoutScale: parseNumberEnv(
      'ENGINE_LIVE_DIARIZE_TIMEOUT_SCALE',
      DEFAULT_LIVE_DIARIZE_TIMEOUT_SCALE,
      0,
    ),
    diarizeTimeoutFloorMs: parseNumberEnv(
      'ENGINE_LIVE_DIARIZE_TIMEOUT_FLOOR_MS',
      DEFAULT_LIVE_DIARIZE_TIMEOUT_FLOOR_MS,
      0,
    ),
  };
}

// --- Config snapshot --------------------------------------------------------
// A flat, serializable record of EVERYTHING that shaped a transcription run:
// the Whisper model + hardware/decoding settings AND the diarization settings
// (which drive the segment `speaker`/`overlap` flags). Written into each output
// JSON so results are self-describing — you can tell which model + settings
// produced a given transcript without guessing. One source of truth: it reads
// the same getConfig() / getDiarizationConfig() the engine actually runs on, so
// the benchmark harness can record configs the same way. `dtype` is a string
// today; when split dtype lands it changes here once.
export interface ConfigSnapshot {
  model: string;
  dtype: string;
  mode: TranscribeMode;
  device: Device;
  // The language the decoder was FORCED to, which is always Turkish — the product has no
  // other output language. Kept as a field rather than dropped because every promoted
  // control-group file carries it and a run is supposed to be self-describing.
  language: string;
  // What the meeting was actually held in, as chosen before recording. This is what
  // decides `model`, so the two must be read together: a 'foreign' snapshot naming the
  // turbo model would mean the choice never reached the engine.
  meetingLanguage: MeetingLanguage;
  diarizationEnabled: boolean;
  diarizationProvider: string;
  diarizationModelVersion: string;
  vad: boolean;
  dictionary: boolean;
}

export function configSnapshot(
  meetingLanguage: MeetingLanguage = DEFAULT_MEETING_LANGUAGE,
): ConfigSnapshot {
  const cfg = getConfig();
  const diar = getDiarizationConfig();
  return {
    // The model that actually ran, not the configured default. Before the foreign path
    // existed these were always the same thing; now a snapshot that reported cfg.modelId
    // unconditionally would quietly mislabel every foreign-language run.
    model: modelForLanguage(meetingLanguage),
    // Raw ENGINE_DTYPE string so the snapshot stays human-readable even for split
    // dtype ("encoder=q8,decoder=fp32"), not the parsed object.
    dtype: process.env.ENGINE_DTYPE || DEFAULT_DTYPE,
    mode: cfg.mode,
    device: cfg.device,
    language: 'tr',
    meetingLanguage,
    diarizationEnabled: diar.enabled,
    diarizationProvider: diar.provider,
    diarizationModelVersion: diar.modelVersion,
    vad: cfg.vad,
    dictionary: cfg.dictionary,
  };
}

// --- Analysis (LLM) ---------------------------------------------------------
// Which model answers is resolved in exactly one place, getLlmConfig(), through three
// tiers in strict order:
//
//   1. A runtime config installed by configureLlm() — what the DESKTOP APP always does at
//      boot, from the user's saved setting (src/main/model-config.ts). Inside the
//      app this tier is never absent, which is why .env cannot change the app's model.
//   2. ENGINE_LLM_* from .env — reachable only when nobody installed a runtime config,
//      i.e. the developer CLIs (`npm run bench`, `npm run test-run`). That is the whole
//      remaining purpose of those variables; see engine/.env.example.
//   3. The first preset in the catalog (local Ollama, qwen3.6:35b-a3b) — so a bare
//      checkout with no .env and no app still analyses offline, with no API key.
//
// The provider is the ONLY thing that decides which adapter runs (analyze/llm/index.ts)
// and what the other values mean, so the per-provider defaults live in one table
// (analyze/llm/catalog.ts) rather than being scattered across the adapters.

// Re-exported from the catalog leaf, which owns the provider table so the renderer can
// read it without loading transformers. Existing importers of models.ts are unaffected.
export type { LlmProvider } from './analyze/llm/catalog.ts';
export { PROVIDER_DEFAULTS } from './analyze/llm/catalog.ts';

// Structured output for OpenAI-compatible servers. 'schema' sends the full
// json_schema response_format; 'object' degrades to plain json_object mode, which
// is the escape hatch for the many OpenAI-compatible servers (older vLLM, some
// OpenRouter models) that accept the endpoint but reject json_schema. Ignored by
// every other provider — they each have exactly one structured-output mechanism.
export type LlmJsonMode = 'schema' | 'object';

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  host: string;
  // '' when the provider needs no key (Ollama). Never logged, never written to an
  // output JSON — see llmSnapshot().
  apiKey: string;
  jsonMode: LlmJsonMode;
  // Response cap. Anthropic REQUIRES max_tokens on every request, which is why this
  // is a first-class config field and not an adapter-local constant.
  maxTokens: number;
  temperature: number;
  numCtx: number;
  timeoutMs: number;
  maxRetries: number;
  mapConcurrency: number;
  chunkTokens: number;
  chunkOverlapTokens: number;
  charsPerToken: number;
}

// Tier 3. Derived from the catalog's first preset rather than written out again here:
// a second hardcoded "the default is Ollama" would be free to drift from the card the
// admin panel presents as the default, and nothing would catch it.
const DEFAULT_PRESET = presetOrDefault(DEFAULT_PRESET_ID);
const DEFAULT_LLM_PROVIDER: LlmProvider = DEFAULT_PRESET.provider;
const DEFAULT_LLM_JSON_MODE: LlmJsonMode = 'schema';
// Matches pipeline.ts's RESPONSE_TOKEN_RESERVE: that is the budget the chunk
// planner already sets aside for the answer, so capping the response there keeps
// the two halves of the same assumption in agreement.
const DEFAULT_LLM_MAX_TOKENS = 4096;
// Cikarma/siniflandirma gorevi; ornekleme cesitliligi burada zarar. 0.2'de ayni dokum
// kosudan kosuya farkli aksiyon listesi veriyordu (S3 depo sayimi, S7-E) — 0 olmadan
// output/analyzer baseline'lari hakem olamiyor.
const DEFAULT_LLM_TEMPERATURE = 0;
const DEFAULT_LLM_NUM_CTX = 8192;
const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const DEFAULT_LLM_MAX_RETRIES = 2;
const DEFAULT_LLM_MAP_CONCURRENCY = 4;
const DEFAULT_LLM_CHUNK_TOKENS = 2200;
const DEFAULT_LLM_CHUNK_OVERLAP_TOKENS = 180;
const DEFAULT_LLM_CHARS_PER_TOKEN = 3.5;

function parseProvider(raw: string | undefined): LlmProvider {
  const token = raw?.trim().toLowerCase();
  if (!token) return DEFAULT_LLM_PROVIDER;
  if (LLM_PROVIDERS.includes(token as LlmProvider)) return token as LlmProvider;
  throw new Error(
    `Geçersiz ENGINE_LLM_PROVIDER "${raw}". İzin verilenler: ${LLM_PROVIDERS.join(', ')}.`,
  );
}

function parseJsonMode(raw: string | undefined): LlmJsonMode {
  const token = raw?.trim().toLowerCase();
  if (!token) return DEFAULT_LLM_JSON_MODE;
  if (token === 'schema' || token === 'object') return token;
  throw new Error(`Geçersiz ENGINE_LLM_JSON_MODE "${raw}". İzin verilenler: schema, object.`);
}

function parseNumberEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

// What the app installs: the four values that decide WHICH model answers. Deliberately
// narrow — timeouts, chunking, temperature and concurrency are NOT here, because those are
// tuning knobs an operator sets once per machine, not something an admin's preset choice
// should quietly rewrite. They stay on .env in every tier.
export interface LlmRuntimeConfig {
  provider: LlmProvider;
  model: string;
  // '' falls back to the provider's published endpoint.
  host: string;
  // '' means the provider needs none (Ollama). It does NOT fall back to the environment:
  // once a runtime config is installed, the app's own screen is the only source of the
  // key, so a stray OPENAI_API_KEY in the shell cannot contradict what the admin sees.
  apiKey: string;
}

// Mirrors configureDiarization: the app installs runtime configuration into the engine
// instead of the engine reaching into the app. Null means "nobody installed one" — the
// state the developer CLIs (bench, test-run) stay in, and the only state in which .env is
// consulted. The desktop app installs a non-null config at boot, always.
let llmRuntime: LlmRuntimeConfig | null = null;

export function configureLlm(config: LlmRuntimeConfig | null): void {
  llmRuntime = config ? { ...config } : null;
}

export function getLlmRuntimeConfig(): LlmRuntimeConfig | null {
  return llmRuntime ? { ...llmRuntime } : null;
}

// Tier 1 vs. tiers 2/3, kept as one function so "which model answers" has a single
// readable answer. An installed runtime config is taken whole: mixing it with .env would
// recreate exactly the ambiguity moving the setting into the app was meant to end.
function resolveLlmSelection(): Pick<LlmConfig, 'provider' | 'model' | 'host' | 'apiKey'> {
  if (llmRuntime) {
    const defaults = PROVIDER_DEFAULTS[llmRuntime.provider];
    return {
      provider: llmRuntime.provider,
      model: llmRuntime.model.trim() || defaults.model || '',
      host: llmRuntime.host.trim() || defaults.url,
      apiKey: llmRuntime.apiKey.trim(),
    };
  }
  const provider = parseProvider(process.env.ENGINE_LLM_PROVIDER);
  const defaults = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    model: process.env.ENGINE_LLM_MODEL?.trim() || defaults.model || '',
    host: process.env.ENGINE_LLM_URL?.trim() || defaults.url,
    apiKey: envApiKeyFor(provider),
  };
}

export function getLlmConfig(): LlmConfig {
  const selection = resolveLlmSelection();
  return {
    ...selection,
    jsonMode: parseJsonMode(process.env.ENGINE_LLM_JSON_MODE),
    maxTokens: parseNumberEnv('ENGINE_LLM_MAX_TOKENS', DEFAULT_LLM_MAX_TOKENS, 256),
    temperature: parseNumberEnv('ENGINE_LLM_TEMPERATURE', DEFAULT_LLM_TEMPERATURE, 0),
    numCtx: parseNumberEnv('ENGINE_LLM_NUM_CTX', DEFAULT_LLM_NUM_CTX, 1024),
    timeoutMs: parseNumberEnv('ENGINE_LLM_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS, 1000),
    maxRetries: parseNumberEnv('ENGINE_LLM_MAX_RETRIES', DEFAULT_LLM_MAX_RETRIES, 0),
    mapConcurrency: parseNumberEnv('ENGINE_LLM_MAP_CONCURRENCY', DEFAULT_LLM_MAP_CONCURRENCY, 1),
    chunkTokens: parseNumberEnv('ENGINE_LLM_CHUNK_TOKENS', DEFAULT_LLM_CHUNK_TOKENS, 128),
    chunkOverlapTokens: parseNumberEnv(
      'ENGINE_LLM_CHUNK_OVERLAP_TOKENS',
      DEFAULT_LLM_CHUNK_OVERLAP_TOKENS,
      0,
    ),
    charsPerToken: parseNumberEnv('ENGINE_LLM_CHARS_PER_TOKEN', DEFAULT_LLM_CHARS_PER_TOKEN, 1),
  };
}

export interface LlmSnapshot {
  provider: LlmProvider;
  model: string;
  host: string;
}

// What an analysis output JSON records about the LLM that produced it — the
// counterpart to configSnapshot() for transcription. Deliberately a hand-built
// object rather than a spread of LlmConfig: apiKey must be impossible to leak
// into a file on disk by someone adding a field upstream.
export function llmSnapshot(config: LlmConfig = getLlmConfig()): LlmSnapshot {
  return { provider: config.provider, model: config.model, host: config.host };
}

// Fail before the first request rather than on a provider's 401/404, where the
// real cause (an unset env var) is invisible. Called by createLlmClient().
//
// The message names whichever tier the reader can actually act on. Inside the app that is
// the settings screen; telling an end user to edit ENGINE_LLM_MODEL would send them to a file
// that is not in charge of the value and that they cannot reach.
export function validateLlmConfig(config: LlmConfig): void {
  const defaults = PROVIDER_DEFAULTS[config.provider];
  const fromApp = llmRuntime !== null;
  if (!config.model) {
    throw new Error(
      fromApp
        ? `Analiz modeli seçilmemiş (sağlayıcı: ${config.provider}). Ayarlar içindeki `
          + 'Analiz modeli sekmesinden bir model adı girin.'
        : `ENGINE_LLM_MODEL ayarlanmalı (ENGINE_LLM_PROVIDER=${config.provider}). `
          + 'Bu sağlayıcı için varsayılan model yok.',
    );
  }
  if (defaults.requiresKey && !config.apiKey) {
    throw new Error(
      fromApp
        ? `${config.provider} için API anahtarı yok. Ayarlar içindeki Analiz modeli `
          + 'sekmesinden anahtarı girin.'
        : `ENGINE_LLM_API_KEY ayarlanmalı (ENGINE_LLM_PROVIDER=${config.provider})`
          + `${defaults.keyEnv ? ` — alternatif olarak ${defaults.keyEnv}` : ''}.`,
    );
  }
}
