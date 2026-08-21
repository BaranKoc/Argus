// The provider catalog: which LLM providers exist, what each one defaults to, and
// the curated presets the Settings UI offers.
//
// This is a deliberate leaf — no Transformers, no Electron, no fs. models.ts pulls
// @huggingface/transformers at module load, so a renderer that imported the provider
// table from there would drag ONNX Runtime into the browser bundle. Keeping the table
// here lets the admin model page (renderer), model-config.ts (main) and models.ts (engine) all
// read the SAME data instead of each carrying its own copy that drifts.
//
// The LlmProvider type lives here for the same reason; models.ts re-exports it so every
// existing importer is unaffected.

export type LlmProvider = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface ProviderMeta {
  url: string;
  // Only Ollama ships a default model. A cloud provider's model ids churn, and a
  // stale hardcoded id fails as a confusing 404 at request time — far worse than
  // refusing up front, so the others require an explicit model (validateLlmConfig).
  model?: string;
  requiresKey: boolean;
  // Provider-conventional key variable, honoured when ENGINE_LLM_API_KEY is unset
  // so an existing shell export keeps working.
  keyEnv?: string;
}

export const PROVIDER_DEFAULTS: Record<LlmProvider, ProviderMeta> = {
  ollama: {
    url: 'http://localhost:11434',
    // qwen3.6:35b-a3b — the office machine is sized for it. Strong Turkish and
    // reliable JSON output. Override with a lighter model on smaller hardware.
    model: 'qwen3.6:35b-a3b',
    requiresKey: false,
  },
  // The base URL includes /v1 because that is what every OpenAI-compatible vendor
  // publishes (openrouter.ai/api/v1, api.groq.com/openai/v1, an LM Studio port).
  // The adapter appends only /chat/completions.
  openai: {
    url: 'https://api.openai.com/v1',
    requiresKey: true,
    keyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    url: 'https://api.anthropic.com',
    requiresKey: true,
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com',
    requiresKey: true,
    keyEnv: 'GEMINI_API_KEY',
  },
};

export const LLM_PROVIDERS = Object.keys(PROVIDER_DEFAULTS) as LlmProvider[];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === 'string' && LLM_PROVIDERS.includes(value as LlmProvider);
}

// A preset is a *starting point*, not a lock: the Settings UI prefills `model` (and, for
// the custom card, `host`) from it and lets the user edit both. That is the answer to the
// churn problem above — when a vendor retires a model id, the fix is one text field, not
// a new release. `suggestedModels` feeds a <datalist>, so the common case is still a
// two-click pick.
export interface LlmPreset {
  id: string;
  label: string;
  provider: LlmProvider;
  defaultModel: string;
  suggestedModels: readonly string[];
  // Boxicons class — the cards are icon-led, and the icon is the fastest way to tell
  // "local" apart from "cloud" at a glance.
  icon: string;
  hint: string;
  badge?: string;
  // Only the custom card exposes the base URL. Every other preset points at its
  // vendor's published endpoint, where a hand-typed host is a mistake, not a feature.
  editableHost: boolean;
}

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: 'local-ollama',
    label: 'Yerel model (Ollama)',
    provider: 'ollama',
    defaultModel: 'qwen3.6:35b-a3b',
    suggestedModels: ['qwen3.6:35b-a3b', 'qwen3:8b', 'qwen2.5:7b', 'llama3.1:8b'],
    icon: 'bx bx-hdd',
    hint: 'Toplantı içeriği bilgisayardan çıkmaz, API anahtarı gerekmez. Güçlü bir makine ister.',
    badge: 'Çevrimdışı',
    editableHost: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    defaultModel: 'gpt-5',
    suggestedModels: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    icon: 'bx bx-cloud',
    hint: 'Bulut. Hızlıdır, yerel donanım gerektirmez; döküm OpenAI sunucularına gönderilir.',
    editableHost: false,
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    provider: 'anthropic',
    defaultModel: 'claude-sonnet-5',
    suggestedModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    icon: 'bx bx-cloud',
    hint: 'Bulut. Uzun dökümlerde güçlü özetleme; döküm Anthropic sunucularına gönderilir.',
    editableHost: false,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    provider: 'gemini',
    defaultModel: 'gemini-flash-latest',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest'],
    icon: 'bx bx-cloud',
    hint: 'Bulut. Düşük maliyetli seçenek; döküm Google sunucularına gönderilir.',
    editableHost: false,
  },
  {
    id: 'custom',
    label: 'Özel sunucu',
    provider: 'openai',
    defaultModel: '',
    suggestedModels: [],
    icon: 'bx bx-been-here',
    hint: 'OpenAI uyumlu herhangi bir sunucu (LM Studio, vLLM, OpenRouter). Adresi siz girersiniz.',
    badge: 'İleri düzey',
    editableHost: true,
  },
];

// The preset a fresh install lands on. Ollama, matching the .env default, so opening
// Settings and switching the toggle on does not silently change which model runs.
export const DEFAULT_PRESET_ID = 'local-ollama';

export function findPreset(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((preset) => preset.id === id);
}

export function presetOrDefault(id: string): LlmPreset {
  return findPreset(id) ?? findPreset(DEFAULT_PRESET_ID)!;
}

export function presetRequiresKey(preset: LlmPreset): boolean {
  return PROVIDER_DEFAULTS[preset.provider].requiresKey;
}

// The single rule for "which environment variable supplies this provider's key".
// getLlmConfig() resolves the key with it, and the settings store asks the same
// function whether a UI-entered key is even needed — so the badge the user sees
// ("ortam değişkeninden alınıyor") can never disagree with what analysis actually does.
//
// ENGINE_LLM_API_KEY is provider-agnostic and therefore only trustworthy while the
// provider in play is the one .env selected; the vendor-conventional variable
// (OPENAI_API_KEY etc.) is provider-scoped and always applies.
export function envApiKeyFor(provider: LlmProvider, env: NodeJS.ProcessEnv = process.env): string {
  const envProvider = env.ENGINE_LLM_PROVIDER?.trim().toLowerCase();
  const generic = !envProvider || envProvider === provider
    ? env.ENGINE_LLM_API_KEY?.trim()
    : '';
  const meta = PROVIDER_DEFAULTS[provider];
  return generic || (meta.keyEnv ? env[meta.keyEnv]?.trim() : '') || '';
}
