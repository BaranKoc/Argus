// Unit tests for configSnapshot() (npm test). No model/audio needed — it just
// reads env-derived config. `npm test` does NOT load engine/.env, so with no env
// vars set we see the built-in defaults; each test saves/restores the ENGINE_*
// vars it touches so it can't leak into the other suites in this process.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  configSnapshot,
  configureLlm,
  getLlmConfig,
  modelForLanguage,
  getLlmRuntimeConfig,
  validateLlmConfig,
} from '../models.ts';

const KEYS = [
  'ENGINE_MODEL',
  'ENGINE_DTYPE',
  'ENGINE_TRANSCRIBE_MODE',
  'ENGINE_DEVICE',
];

const LLM_KEYS = [
  'ENGINE_LLM_PROVIDER',
  'ENGINE_LLM_MODEL',
  'ENGINE_LLM_URL',
  'ENGINE_LLM_API_KEY',
  'ENGINE_LLM_JSON_MODE',
  'ENGINE_LLM_MAX_TOKENS',
  'ENGINE_LLM_TIMEOUT_MS',
  'ENGINE_LLM_MAP_CONCURRENCY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
];

describe('configSnapshot', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reflects the engine defaults when no env vars are set', () => {
    const s = configSnapshot();
    assert.equal(s.model, 'onnx-community/whisper-large-v3-turbo');
    assert.equal(s.dtype, 'q8');
    assert.equal(s.mode, 'chunked');
    assert.equal(s.device, 'cpu');
    assert.equal(s.language, 'tr');
    assert.equal(s.diarizationEnabled, false);
    assert.equal(s.diarizationProvider, 'pyannote-community-1');
  });

  it('reflects engine environment overrides without changing app-owned diarization settings', () => {
    process.env.ENGINE_MODEL = 'onnx-community/whisper-large-v3-turbo';
    process.env.ENGINE_DTYPE = 'fp32';
    process.env.ENGINE_TRANSCRIBE_MODE = 'sequential';

    const s = configSnapshot();
    assert.equal(s.model, 'onnx-community/whisper-large-v3-turbo');
    assert.equal(s.dtype, 'fp32');
    assert.equal(s.mode, 'sequential');
    assert.equal(s.language, 'tr');
    assert.equal(s.diarizationEnabled, false);
  });
});

describe('meeting language → model', () => {
  const KEYS = ['ENGINE_MODEL', 'ENGINE_MODEL_FOREIGN'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('keeps Turkish on turbo and sends foreign meetings to medium', () => {
    assert.equal(modelForLanguage('turkish'), 'onnx-community/whisper-large-v3-turbo');
    assert.equal(modelForLanguage('foreign'), 'onnx-community/whisper-medium-ONNX');
    // Omitted argument must behave as Turkish — every existing caller relies on it.
    assert.equal(modelForLanguage(), modelForLanguage('turkish'));
  });

  it('lets each model be overridden independently', () => {
    process.env.ENGINE_MODEL = 'custom/tr-model';
    process.env.ENGINE_MODEL_FOREIGN = 'custom/foreign-model';
    assert.equal(modelForLanguage('turkish'), 'custom/tr-model');
    assert.equal(modelForLanguage('foreign'), 'custom/foreign-model');
  });

  // The snapshot is what an output JSON claims it was produced with. Reporting the
  // configured default on a foreign run would mislabel the file and, since promoted
  // files become references, quietly corrupt the control group.
  it('records the model that actually ran, not the configured default', () => {
    const turkish = configSnapshot('turkish');
    const foreign = configSnapshot('foreign');

    assert.equal(turkish.model, 'onnx-community/whisper-large-v3-turbo');
    assert.equal(turkish.meetingLanguage, 'turkish');
    assert.equal(foreign.model, 'onnx-community/whisper-medium-ONNX');
    assert.equal(foreign.meetingLanguage, 'foreign');
    // The decode language is Turkish on both paths — that is the whole point.
    assert.equal(foreign.language, 'tr');
  });
});

// Tier 2 + tier 3: what the developer CLIs (bench, test-run) see, because nothing installs
// a runtime config there. Inside the desktop app this whole suite is unreachable — see the
// tier-1 suite below.
describe('getLlmConfig without an installed runtime config (CLI tier)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of LLM_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of LLM_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Tier 3: a bare checkout with no .env and no app still analyses offline. This is the
  // catalog's first preset, not a second hardcoded default.
  it('falls back to the first preset when neither a runtime config nor .env exists', () => {
    const c = getLlmConfig();
    assert.equal(c.provider, 'ollama');
    assert.equal(c.model, 'qwen3.6:35b-a3b');
    assert.equal(c.host, 'http://localhost:11434');
    assert.equal(c.apiKey, '');
    assert.equal(c.jsonMode, 'schema');
  });

  it('applies the per-provider default URL when ENGINE_LLM_URL is unset', () => {
    process.env.ENGINE_LLM_PROVIDER = 'anthropic';
    assert.equal(getLlmConfig().host, 'https://api.anthropic.com');

    process.env.ENGINE_LLM_PROVIDER = 'gemini';
    assert.equal(getLlmConfig().host, 'https://generativelanguage.googleapis.com');
  });

  it('leaves the model empty for cloud providers instead of guessing a model id', () => {
    process.env.ENGINE_LLM_PROVIDER = 'openai';
    assert.equal(getLlmConfig().model, '');
  });

  it('falls back to the provider-conventional key variable', () => {
    process.env.ENGINE_LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'from-shell';
    assert.equal(getLlmConfig().apiKey, 'from-shell');

    process.env.ENGINE_LLM_API_KEY = 'from-dotenv';
    assert.equal(getLlmConfig().apiKey, 'from-dotenv');
  });

  it('rejects an unknown provider by name', () => {
    process.env.ENGINE_LLM_PROVIDER = 'llamafile';
    assert.throws(() => getLlmConfig(), /Geçersiz ENGINE_LLM_PROVIDER/);
  });

  it('rejects an unknown json mode', () => {
    process.env.ENGINE_LLM_JSON_MODE = 'yaml';
    assert.throws(() => getLlmConfig(), /Geçersiz ENGINE_LLM_JSON_MODE/);
  });
});

// Tier 1: what the desktop app is always in, because main/index.ts installs the saved
// setting at boot. The point of every test here is that .env cannot reach the app.
describe('configureLlm (app tier)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of LLM_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  // Module-level state: a config left installed would silently reconfigure every test that
  // runs after this suite.
  afterEach(() => {
    configureLlm(null);
    for (const k of LLM_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is inert until installed, and returns to the CLI tiers when cleared', () => {
    process.env.ENGINE_LLM_PROVIDER = 'openai';
    process.env.ENGINE_LLM_MODEL = 'gpt-from-env';
    process.env.ENGINE_LLM_API_KEY = 'env-key';
    assert.equal(getLlmRuntimeConfig(), null);
    assert.equal(getLlmConfig().model, 'gpt-from-env');

    configureLlm({ provider: 'openai', model: 'gpt-from-admin', host: '', apiKey: 'admin-key' });
    assert.equal(getLlmConfig().model, 'gpt-from-admin');
    assert.equal(getLlmConfig().apiKey, 'admin-key');

    configureLlm(null);
    assert.equal(getLlmConfig().model, 'gpt-from-env');
  });

  // The whole reason the setting moved out of .env: an installed config is taken WHOLE, so
  // a leftover ENGINE_LLM_* line cannot half-apply to a provider it was never written for.
  it('ignores every ENGINE_LLM_* selection value once a config is installed', () => {
    process.env.ENGINE_LLM_PROVIDER = 'ollama';
    process.env.ENGINE_LLM_MODEL = 'qwen2.5:7b';
    process.env.ENGINE_LLM_URL = 'http://office-box:11434';
    process.env.ENGINE_LLM_API_KEY = 'stale';

    configureLlm({ provider: 'openai', model: 'gpt-5', host: '', apiKey: 'admin-key' });
    const c = getLlmConfig();
    assert.equal(c.provider, 'openai');
    assert.equal(c.model, 'gpt-5');
    assert.equal(c.host, 'https://api.openai.com/v1');
    assert.equal(c.apiKey, 'admin-key');
  });

  // Even for the SAME provider .env must not fill a gap: the admin screen showing an empty
  // key while analysis quietly used a shell variable is exactly the confusion being removed.
  it('does not let a shell key fill in for an installed config', () => {
    process.env.OPENAI_API_KEY = 'sk-shell';
    configureLlm({ provider: 'openai', model: 'gpt-5', host: '', apiKey: '' });
    assert.equal(getLlmConfig().apiKey, '');
  });

  it('applies the provider default host and model when the config leaves them blank', () => {
    configureLlm({ provider: 'ollama', model: '', host: '', apiKey: '' });
    const c = getLlmConfig();
    assert.equal(c.model, 'qwen3.6:35b-a3b');
    assert.equal(c.host, 'http://localhost:11434');
  });

  it('leaves the tuning knobs on .env — the admin only picks which model answers', () => {
    process.env.ENGINE_LLM_TIMEOUT_MS = '45000';
    process.env.ENGINE_LLM_MAP_CONCURRENCY = '2';
    process.env.ENGINE_LLM_JSON_MODE = 'object';

    configureLlm({ provider: 'openai', model: 'gpt-5', host: '', apiKey: 'k' });
    const c = getLlmConfig();
    assert.equal(c.timeoutMs, 45000);
    assert.equal(c.mapConcurrency, 2);
    assert.equal(c.jsonMode, 'object');
  });

  it('points a misconfigured app at settings, not at .env', () => {
    configureLlm({ provider: 'openai', model: 'gpt-5', host: '', apiKey: '' });
    assert.throws(() => validateLlmConfig(getLlmConfig()), /Ayarlar içindeki Analiz modeli/);

    configureLlm(null);
    process.env.ENGINE_LLM_PROVIDER = 'openai';
    assert.throws(() => validateLlmConfig(getLlmConfig()), /ENGINE_LLM_MODEL/);
  });
});

