import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ModelConfigStore } from './model-config.ts';

const dirs: string[] = [];
function makeStore(): { store: ModelConfigStore; dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-model-'));
  dirs.push(dir);
  const store = new ModelConfigStore(dir);
  return { store, dir, file: path.join(dir, 'model-config.json') };
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('ModelConfigStore', () => {
  it('runs on the first preset before the user has changed it', () => {
    const { store, file } = makeStore();
    assert.equal(fs.existsSync(file), false, 'a missing file is the normal first-run state');
    assert.deepEqual(store.runtimeConfig(), {
      provider: 'ollama',
      model: 'qwen3.6:35b-a3b',
      host: '',
      apiKey: '',
    });
    const view = store.get();
    assert.equal(view.presetId, 'local-ollama');
    assert.equal(view.source, 'local');
    assert.equal(view.hasApiKey, false);
    assert.equal(view.readOnlyReason, '');
  });

  it('stores the API key on disk but never returns it', () => {
    const { store, file } = makeStore();
    store.set({ presetId: 'openai', model: 'gpt-5', apiKey: 'sk-secret-do-not-leak' });

    const view = store.get();
    assert.equal(view.hasApiKey, true);
    assert.equal(view.apiKeyHint, '••••leak');
    assert.equal(JSON.stringify(view).includes('sk-secret'), false);
    // It does have to reach the disk — that is the point of entering it in settings.
    assert.match(fs.readFileSync(file, 'utf8'), /sk-secret-do-not-leak/);
    assert.equal(store.runtimeConfig().apiKey, 'sk-secret-do-not-leak');
  });

  it('keeps the stored key when a later patch omits it, and clears it on null', () => {
    const { store } = makeStore();
    store.set({ presetId: 'openai', model: 'gpt-5', apiKey: 'sk-one' });
    store.set({ model: 'gpt-5-mini' });
    assert.equal(store.get().hasApiKey, true);
    assert.equal(store.runtimeConfig().model, 'gpt-5-mini');

    assert.throws(() => store.set({ apiKey: null }), /API anahtarı/);
  });

  // An OpenAI key is not an Anthropic key, and an Ollama model name is not a Gemini one.
  it('drops the previous model and key when the preset changes', () => {
    const { store } = makeStore();
    store.set({ presetId: 'openai', model: 'gpt-5', apiKey: 'sk-one' });
    store.set({ presetId: 'local-ollama' });

    const view = store.get();
    assert.equal(view.hasApiKey, false);
    assert.equal(view.model, '');
    assert.equal(store.runtimeConfig().model, 'qwen3.6:35b-a3b');
  });

  // .env no longer applies inside the app, so a cloud preset needs a key entered here —
  // and the store must say so rather than letting analysis fail after a whole meeting.
  it('refuses a cloud preset with no key', () => {
    const { store } = makeStore();
    assert.throws(() => store.set({ presetId: 'openai', model: 'gpt-5' }), /API anahtarı/);
    assert.equal(store.get().presetId, 'local-ollama', 'a rejected patch must not persist');
  });

  it('requires a host from the custom preset only', () => {
    const { store } = makeStore();
    assert.throws(
      () => store.set({ presetId: 'custom', model: 'my-model', apiKey: 'k' }),
      /sunucu adresi/,
    );
    store.set({ presetId: 'custom', model: 'my-model', host: 'http://box:1234/v1', apiKey: 'k' });
    assert.equal(store.runtimeConfig().host, 'http://box:1234/v1');
  });

  it('ignores a host on a preset that does not expose one', () => {
    const { store } = makeStore();
    store.set({ presetId: 'openai', model: 'gpt-5', host: 'http://sneaky', apiKey: 'k' });
    assert.equal(store.runtimeConfig().host, '');
  });

  it('rejects an unknown preset', () => {
    const { store } = makeStore();
    assert.throws(() => store.set({ presetId: 'retired' }), /Bilinmeyen/);
  });

  it('survives a restart', () => {
    const { store, dir } = makeStore();
    store.set({ presetId: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-xyz1234' });

    const reopened = new ModelConfigStore(dir);
    assert.equal(reopened.get().presetId, 'anthropic');
    assert.equal(reopened.runtimeConfig().model, 'claude-sonnet-5');
    assert.equal(reopened.runtimeConfig().apiKey, 'sk-ant-xyz1234');
  });

  it('falls back to defaults for a corrupt or retired-preset file', () => {
    for (const contents of ['{ not json', '[]', 'null', '{"presetId":"retired"}']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-model-'));
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, 'model-config.json'), contents);
      const store = new ModelConfigStore(dir);
      assert.equal(store.get().presetId, 'local-ollama', contents);
      assert.equal(store.runtimeConfig().provider, 'ollama', contents);
    }
  });

  it('keeps the remote source marker, the seam for a central server', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-model-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'model-config.json'),
      JSON.stringify({ source: 'remote', presetId: 'openai', model: 'gpt-5', apiKey: 'k' }),
    );
    assert.equal(new ModelConfigStore(dir).get().source, 'remote');
  });

  // The setting still applies to the running app even if persistence fails.
  it('reports a failed write instead of swallowing it', () => {
    const { store, dir } = makeStore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not a directory');

    const view = store.set({ presetId: 'openai', model: 'gpt-5', apiKey: 'sk-abcdefghij' });
    assert.match(view.readOnlyReason, /diske yazılamadı/);
    assert.equal(store.runtimeConfig().model, 'gpt-5', 'still honoured this session');

    fs.rmSync(dir, { force: true });
  });
});
