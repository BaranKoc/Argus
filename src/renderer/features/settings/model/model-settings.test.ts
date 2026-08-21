import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelConfigView } from '../../../../preload/index.ts';
import {
  draftForPreset,
  draftFromConfig,
  hasPendingChanges,
  keyStateText,
  modelBlockerText,
  modelStatusText,
  resolveModelSelection,
  scopeText,
} from './model-settings.ts';

const view = (overrides: Partial<ModelConfigView> = {}): ModelConfigView => ({
  source: 'local',
  presetId: 'local-ollama',
  model: '',
  host: '',
  hasApiKey: false,
  apiKeyHint: '',
  path: 'C:/Users/example/AppData/Roaming/argus/model-config.json',
  readOnlyReason: '',
  ...overrides,
});

describe('resolveModelSelection', () => {
  it('falls back to the default preset for a response from an older main process', () => {
    assert.equal(resolveModelSelection(undefined).preset.id, 'local-ollama');
  });

  it('falls back to the default preset when the stored id no longer exists', () => {
    assert.equal(resolveModelSelection(view({ presetId: 'retired' })).preset.id, 'local-ollama');
  });

  it("shows the preset's model until the admin overrides it", () => {
    assert.equal(resolveModelSelection(view()).model, 'qwen3.6:35b-a3b');
    assert.equal(resolveModelSelection(view({ model: 'qwen2.5:7b' })).model, 'qwen2.5:7b');
  });

  it('asks for no key from a provider that needs none', () => {
    const selection = resolveModelSelection(view());
    assert.equal(selection.keyState, 'not-needed');
    assert.equal(selection.usable, true);
    assert.equal(modelBlockerText(selection), '');
  });

  // .env cannot supply the key any more, so the only source is this screen — and a cloud
  // preset with an empty box must say so rather than looking ready.
  it('blocks a cloud preset with no key', () => {
    const selection = resolveModelSelection(view({ presetId: 'openai', model: 'gpt-5' }));
    assert.equal(selection.keyState, 'missing');
    assert.equal(selection.usable, false);
    assert.match(modelBlockerText(selection), /API anahtarı/);
  });

  it('accepts a cloud preset once a key is stored', () => {
    const selection = resolveModelSelection(
      view({ presetId: 'openai', model: 'gpt-5', hasApiKey: true, apiKeyHint: '••••abcd' }),
    );
    assert.equal(selection.keyState, 'stored');
    assert.equal(selection.usable, true);
    assert.match(keyStateText(selection), /••••abcd/);
  });

  it('requires a host from the custom preset only', () => {
    const custom = resolveModelSelection(
      view({ presetId: 'custom', model: 'my-model', hasApiKey: true }),
    );
    assert.equal(custom.showHost, true);
    assert.equal(custom.usable, false);
    assert.match(modelBlockerText(custom), /sunucu adresi/i);

    const withHost = resolveModelSelection(
      view({ presetId: 'custom', model: 'my-model', host: 'http://box:1234/v1', hasApiKey: true }),
    );
    assert.equal(withHost.usable, true);
    assert.equal(resolveModelSelection(view()).showHost, false);
  });

  it('reports a missing model as the first thing to fix', () => {
    const selection = resolveModelSelection(view({ presetId: 'custom', host: 'http://box/v1' }));
    assert.equal(selection.model, '');
    assert.match(modelBlockerText(selection), /model adı/);
  });
});

// The regression suite for the bug that made every cloud preset unselectable: picking a
// card used to be a save, so the store rejected the half-finished config and the screen
// snapped back before the admin could reach the key field.
describe('draft (unsaved form state)', () => {
  const saved = view();

  it('keeps a freshly picked cloud preset selected even though it is incomplete', () => {
    const draft = draftForPreset('openai');
    const selection = resolveModelSelection(saved, draft);

    assert.equal(selection.preset.id, 'openai', 'the card must stay on the one just clicked');
    assert.equal(selection.model, 'gpt-5', "prefilled from the preset's default");
    assert.equal(selection.keyState, 'missing');
    assert.equal(selection.usable, false);
    assert.match(modelBlockerText(selection), /API anahtarı/);
  });

  it('becomes saveable as soon as a key is typed, before it is stored', () => {
    const draft = { ...draftForPreset('openai'), apiKeyEntered: true };
    const selection = resolveModelSelection(saved, draft);

    assert.equal(selection.usable, true);
    assert.equal(modelBlockerText(selection), '');
    // Not yet stored, so it must not be described as "kayıtlı".
    assert.equal(selection.apiKeyHint, '');
    assert.match(keyStateText(selection), /Kaydet ile saklanacak/);
  });

  it('abandons a stored key when the draft moves to another provider', () => {
    const withKey = view({ presetId: 'openai', model: 'gpt-5', hasApiKey: true, apiKeyHint: '••••abcd' });
    // Staying put keeps it...
    assert.equal(resolveModelSelection(withKey, draftFromConfig(withKey)).keyState, 'stored');
    // ...moving to Gemini does not: an OpenAI key is not a Gemini key.
    const moved = resolveModelSelection(withKey, draftForPreset('gemini'));
    assert.equal(moved.keyState, 'missing');
    assert.equal(moved.usable, false);
  });

  it('asks the custom preset for a model and a host, then accepts it', () => {
    let draft = draftForPreset('custom');
    assert.equal(resolveModelSelection(saved, draft).model, '', 'no default to fall back to');
    assert.match(modelBlockerText(resolveModelSelection(saved, draft)), /model adı/);

    draft = { ...draft, model: 'my-model' };
    assert.match(modelBlockerText(resolveModelSelection(saved, draft)), /sunucu adresi/i);

    draft = { ...draft, host: 'http://box:1234/v1', apiKeyEntered: true };
    assert.equal(resolveModelSelection(saved, draft).usable, true);
  });

  it('describes the saved config when no draft is supplied', () => {
    const stored = view({ presetId: 'anthropic', model: 'claude-sonnet-5', hasApiKey: true });
    const selection = resolveModelSelection(stored);
    assert.equal(selection.preset.id, 'anthropic');
    assert.equal(selection.usable, true);
  });

  it('starts the draft from what is saved', () => {
    const stored = view({ presetId: 'custom', model: 'm', host: 'http://box/v1' });
    assert.deepEqual(draftFromConfig(stored), {
      presetId: 'custom',
      model: 'm',
      host: 'http://box/v1',
      apiKeyEntered: false,
    });
    // A blank stored model shows the preset's default rather than an empty box.
    assert.equal(draftFromConfig(view()).model, 'qwen3.6:35b-a3b');
  });
});

describe('hasPendingChanges', () => {
  it('is false for an untouched form', () => {
    const stored = view({ presetId: 'openai', model: 'gpt-5', hasApiKey: true });
    assert.equal(hasPendingChanges(stored, draftFromConfig(stored)), false);
  });

  it('is true for a changed preset, model, host or a newly typed key', () => {
    const stored = view();
    const base = draftFromConfig(stored);
    assert.equal(hasPendingChanges(stored, draftForPreset('openai')), true);
    assert.equal(hasPendingChanges(stored, { ...base, model: 'qwen2.5:7b' }), true);
    assert.equal(hasPendingChanges(stored, { ...base, apiKeyEntered: true }), true);
  });
});

describe('modelStatusText', () => {
  it('names the model that will actually run', () => {
    const text = modelStatusText(resolveModelSelection(view({ model: 'qwen2.5:7b' })));
    assert.match(text, /qwen2\.5:7b/);
    assert.match(text, /Yerel model/);
  });
});

describe('scopeText', () => {
  it('says the setting is local to the user and where it lives', () => {
    const text = scopeText(view());
    assert.match(text, /bu kullanıcı için yerel/);
    assert.match(text, /model-config\.json/);
  });

  // A failed write outranks the location.
  it('reports a failed write instead of the path', () => {
    const text = scopeText(view({ readOnlyReason: 'Ayar diske yazılamadı (EACCES).' }));
    assert.match(text, /yazılamadı/);
    assert.doesNotMatch(text, /bu kullanıcı için yerel/);
  });

  it('says so when the setting came from a central server', () => {
    assert.match(scopeText(view({ source: 'remote' })), /merkezi sunucudan/);
  });
});
