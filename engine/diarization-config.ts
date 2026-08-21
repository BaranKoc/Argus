// Shared audio constants and the runtime-owned diarization configuration. This
// leaf intentionally stays free of Transformers/Electron imports: the Python
// worker is isolated from both native runtimes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MODELS_DIR = path.join(path.dirname(SCRIPT_DIR), 'models');
export const SAMPLE_RATE = 16000;
export const RESULT_MARKER = '__DIAR_RESULT__';
export const STATS_MARKER = '__DIAR_STATS__';
export const PYANNOTE_PROVIDER = 'pyannote-community-1' as const;
export const PYANNOTE_MODEL_VERSION = 'speaker-diarization-community-1';

// 'cuda' is strict — no GPU means the worker fails and the meeting finishes without
// speaker labels. 'auto' falls back to CPU and 'cpu' is explicit; both exist for
// diarize-bench, which has to be able to time the two devices against each other.
export type DiarizationDevice = 'auto' | 'cuda' | 'cpu';

// GPU-only in the product. CPU diarization was measured at 11.7 min for a 24.5 min
// meeting with a 14.7 GB RSS peak (vs 1.0 min / 2.0 GB on CUDA), which is not a mode
// worth silently falling back into — a user who gets it would think the feature is
// simply broken. The Full installer ships the CUDA runtime; the Light one ships none.
export const DEFAULT_DIARIZATION_DEVICE: DiarizationDevice = 'cuda';

export interface DiarizationConfig {
  enabled: boolean;
  provider: typeof PYANNOTE_PROVIDER;
  pythonPath: string | null;
  modelDir: string | null;
  modelVersion: string;
  // Optional on purpose: the desktop app never chooses a device — the product is
  // CUDA-only, so there is nothing to choose. Its three configureDiarization() callers
  // therefore stay untouched and land on DEFAULT_DIARIZATION_DEVICE; only diarize-bench
  // sets this, to time cpu against cuda.
  device?: DiarizationDevice;
}

let runtimeConfig: DiarizationConfig = {
  enabled: false,
  provider: PYANNOTE_PROVIDER,
  pythonPath: null,
  modelDir: null,
  modelVersion: PYANNOTE_MODEL_VERSION,
  device: DEFAULT_DIARIZATION_DEVICE,
};

export function configureDiarization(config: DiarizationConfig): void {
  runtimeConfig = { ...config, device: config.device ?? DEFAULT_DIARIZATION_DEVICE };
}

export function getDiarizationConfig(): DiarizationConfig {
  return { ...runtimeConfig };
}
