// The local user's analysis-model configuration. It sits beside the rest of Argus's
// settings under Electron userData and never crosses into the renderer with its API key.
//
// `source` is the server seam: today every install reads its own local file. When the
// central topology is decided (docs/roadmap.md), 'remote' means this store fetches instead
// of reading, and nothing upstream — ipc.ts, the settings view, configureLlm — changes shape.

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PRESET_ID,
  findPreset,
  presetOrDefault,
  presetRequiresKey,
  type LlmPreset,
  type LlmProvider,
} from '../../engine/analyze/llm/catalog.ts';

// Structurally engine/models.ts's LlmRuntimeConfig, declared against the catalog leaf:
// this module is unit-tested under plain `node --test`, and engine/models.ts loads
// @huggingface/transformers at import time.
export interface LlmRuntimeConfig {
  provider: LlmProvider;
  model: string;
  host: string;
  apiKey: string;
}

export type ModelConfigSource = 'local' | 'remote';

export interface ModelConfig {
  source: ModelConfigSource;
  presetId: string;
  // '' means "use the preset's default model". Stored rather than resolved so switching
  // presets and back does not silently keep the other preset's model.
  model: string;
  // '' means "use the provider's published endpoint". Only the custom preset sets it.
  host: string;
}

// What the renderer is allowed to see. The key itself never crosses IPC — only whether one
// is stored and its last four characters, which is enough to tell two keys apart without
// putting a secret in the process that renders untrusted meeting text.
export interface ModelConfigView extends ModelConfig {
  hasApiKey: boolean;
  apiKeyHint: string;
  // Where the file actually lives, so the settings screen can say so — a setting that
  // does not say where it is stored is impossible to support over the phone.
  path: string;
  // Set when the last write failed.
  // Surfaced rather than swallowed: silently keeping a setting only in memory would be the
  // worst outcome for a setting whose whole point is that it is shared.
  readOnlyReason: string;
}

export interface ModelConfigPatch {
  presetId?: string;
  model?: string;
  host?: string;
  // undefined keeps the stored key, null clears it, a string replaces it. Three states
  // because the renderer never receives the key back and so cannot echo it unchanged.
  apiKey?: string | null;
}

interface StoredModelConfig extends ModelConfig {
  apiKey: string;
}

const DEFAULTS: StoredModelConfig = {
  source: 'local',
  presetId: DEFAULT_PRESET_ID,
  model: '',
  host: '',
  apiKey: '',
};

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// Last four characters only, and only when there are enough of them to be ambiguous on
// their own. A short key is shown as dots alone rather than leaking most of itself.
function keyHint(apiKey: string): string {
  if (!apiKey) return '';
  return apiKey.length > 8 ? `••••${apiKey.slice(-4)}` : '••••';
}

export class ModelConfigStore {
  readonly #dir: string;
  readonly #file: string;
  #config: StoredModelConfig;
  #readOnlyReason = '';

  constructor(dir: string) {
    this.#dir = dir;
    this.#file = path.join(dir, 'model-config.json');
    this.#config = this.#read();
  }

  get filePath(): string {
    return this.#file;
  }

  // A missing file is the normal first-run state, not an error: the install simply runs on
  // the first preset until the user says otherwise. A corrupt one falls back the same way
  // rather than throwing — a bad line here must not make the app unlaunchable.
  #read(): StoredModelConfig {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      return { ...DEFAULTS };
    }
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };
    const raw = parsed as Partial<StoredModelConfig>;
    const presetId = findPreset(readString(raw.presetId)) ? raw.presetId as string : DEFAULT_PRESET_ID;
    return {
      source: raw.source === 'remote' ? 'remote' : 'local',
      presetId,
      model: readString(raw.model),
      host: readString(raw.host),
      apiKey: readString(raw.apiKey),
    };
  }

  #persist(): void {
    fs.mkdirSync(this.#dir, { recursive: true });
    const tempPath = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.#config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.#file);
  }

  get(): ModelConfigView {
    const { apiKey, ...rest } = this.#config;
    return {
      ...rest,
      hasApiKey: apiKey.length > 0,
      apiKeyHint: keyHint(apiKey),
      path: this.#file,
      readOnlyReason: this.#readOnlyReason,
    };
  }

  // Never null: the app always runs on a definite choice, and with no file on disk that choice
  // is the first preset. This is what makes .env irrelevant
  // inside the app — main/index.ts installs this at boot, unconditionally.
  runtimeConfig(): LlmRuntimeConfig {
    const preset = presetOrDefault(this.#config.presetId);
    return {
      provider: preset.provider,
      model: this.#config.model.trim() || preset.defaultModel,
      host: preset.editableHost ? this.#config.host.trim() : '',
      apiKey: this.#config.apiKey,
    };
  }

  // Validated before it is persisted, not at analysis time: a half-configured model that
  // only fails when a meeting ends would cost the user the whole recording's analysis, and
  // the error would surface far from the screen that caused it.
  set(patch: ModelConfigPatch): ModelConfigView {
    const current = this.#config;
    const presetId = patch.presetId ?? current.presetId;
    const preset = findPreset(presetId);
    if (!preset) throw new Error('Bilinmeyen analiz modeli ön ayarı.');

    // Switching presets drops the previous preset's model/host/key unless this same call
    // supplies new ones — an OpenAI key must never be carried over to Gemini.
    const switched = presetId !== current.presetId;
    const next: StoredModelConfig = {
      ...current,
      presetId,
      model: (patch.model ?? (switched ? '' : current.model)).trim(),
      host: (patch.host ?? (switched ? '' : current.host)).trim(),
      apiKey: patch.apiKey === undefined
        ? (switched ? '' : current.apiKey)
        : (patch.apiKey ?? '').trim(),
    };
    if (!preset.editableHost) next.host = '';

    assertUsable(preset, next);

    const previous = this.#config;
    this.#config = next;
    try {
      this.#persist();
      this.#readOnlyReason = '';
    } catch (error) {
      // Keep the value in memory so the running app honours it, but tell the truth: it
      // will be gone on restart.
      this.#readOnlyReason = `Ayar bu oturum için geçerli ama diske yazılamadı (${this.#file}): `
        + `${(error as Error).message}`;
      void previous;
    }
    return this.get();
  }

}

function assertUsable(preset: LlmPreset, config: StoredModelConfig): void {
  if (!(config.model || preset.defaultModel)) {
    throw new Error('Bu sağlayıcı için bir model adı girmelisiniz.');
  }
  if (preset.editableHost && !config.host) {
    throw new Error('Özel sunucu için sunucu adresi girmelisiniz.');
  }
  if (presetRequiresKey(preset) && !config.apiKey) {
    throw new Error(`${preset.label} için API anahtarı girmelisiniz.`);
  }
}
