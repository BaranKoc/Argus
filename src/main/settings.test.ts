import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { SettingsStore } from './settings.ts';

const dirs: string[] = [];
function makeStore(): { store: SettingsStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-settings-'));
  dirs.push(dir);
  return { store: new SettingsStore(dir), dir };
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('SettingsStore', () => {
  it('defaults to disabled and persists no token-shaped field', () => {
    const { store, dir } = makeStore();
    assert.deepEqual(store.get(), {
      diarization: { enabled: false, provider: 'pyannote-community-1' },
      analysis: { includeSpeakers: false },
    });
    store.setEnabled(false);
    const saved = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    assert.equal(saved.includes('token'), false);
    assert.equal(saved.includes('huggingface'), false);
  });

  it('rejects enabling before the local runtime and model are ready', () => {
    const { store } = makeStore();
    assert.throws(() => store.setEnabled(true), /paketine eklenmelidir/);
    assert.throws(() => store.setIncludeSpeakers(true), /konuşmacı ayrımı etkinken/);
  });

  // A missing runtime is the expected first-run state: it is too large to ship in the
  // installer and arrives as a separate add-on. The renderer needs the reason to offer
  // the install button instead of blaming the user's package.
  it('reports why diarization is unavailable, not just that it is', () => {
    const { store } = makeStore();
    const status = store.status();
    assert.equal(status.ready, false);
    assert.equal(status.reason, 'no-runtime');
    assert.match(status.message, /GPU desteği/);
  });

  it('migrates an enabled legacy setting to speaker-aware analysis', () => {
    const { dir } = makeStore();
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ diarization: { enabled: true, provider: 'pyannote-community-1' } }),
    );
    const store = new SettingsStore(dir);
    assert.equal(store.get().analysis.includeSpeakers, true);
  });

  // relativePython selects between the developer venv layout (Scripts/python.exe)
  // and the relocatable CPython the distributable ships (python.exe at the root).
  function provision(dir: string, relativePython: string): { modelRoot: string; python: string } {
    const modelRoot = path.join(dir, 'models', 'pyannote');
    const python = path.join(modelRoot, 'runtime', relativePython);
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
    const modelDir = path.join(modelRoot, 'speaker-diarization-community-1');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'config.yaml'), '');
    return { modelRoot, python };
  }

  const VENV_PYTHON = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const PORTABLE_PYTHON = process.platform === 'win32' ? 'python.exe' : 'bin/python';

  it('keeps the analysis preference in sync when diarization is toggled', () => {
    const { dir } = makeStore();
    const { modelRoot } = provision(dir, VENV_PYTHON);
    const store = new SettingsStore(dir, modelRoot);

    assert.equal(store.setEnabled(true).analysis.includeSpeakers, true);
    assert.equal(store.setEnabled(false).analysis.includeSpeakers, false);
  });

  it('finds the interpreter in both the venv and the relocatable runtime layout', () => {
    for (const relativePython of new Set([VENV_PYTHON, PORTABLE_PYTHON])) {
      const { dir } = makeStore();
      const { modelRoot, python } = provision(dir, relativePython);
      const store = new SettingsStore(dir, modelRoot);

      assert.equal(store.status().ready, true, relativePython);
      assert.equal(store.engineConfig().pythonPath, python, relativePython);
    }
  });

  it('keeps runtime and model assets under the supplied project models directory', () => {
    const { dir } = makeStore();
    const modelRoot = path.join(dir, 'models', 'pyannote');
    const store = new SettingsStore(dir, modelRoot);
    assert.equal(
      store.engineConfig().modelDir,
      path.join(modelRoot, 'speaker-diarization-community-1'),
    );
  });
});

// The LLM half of this store moved to model-config.ts so provider secrets and speaker
// preferences remain separate shapes. Its tests live in model-config.test.ts.
describe('legacy settings.json', () => {
  it('ignores an llm block left by an intermediate build instead of migrating it', () => {
    const { dir } = makeStore();
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        diarization: { enabled: false, provider: 'pyannote-community-1' },
        analysis: { includeSpeakers: false },
        llm: { enabled: true, presetId: 'openai', model: 'gpt-5', apiKey: 'sk-old' },
      }),
    );
    const store = new SettingsStore(dir);
    // Promoting one account's choice to everyone's is the wrong direction — the admin
    // sets it again in the Analiz modeli tab.
    assert.deepEqual(Object.keys(store.get()).sort(), ['analysis', 'diarization']);
  });
});
