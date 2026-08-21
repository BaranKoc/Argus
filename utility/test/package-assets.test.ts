import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  ASSET_GROUPS,
  CUDA_RUNTIME_DIR,
  UNPACKED_FORBIDDEN,
  UNPACKED_REQUIRED,
  assertPackageInputs,
  missingPackageInputs,
} = require('../package-assets.cjs');

interface AssetGroup { name: string; command: string; files: string[] }

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-package-assets-'));
}

function write(root: string, relative: string, contents = 'fixture'): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

// A CUDA torch tree carries a version.py whose `cuda` is a version string; the CPU wheel
// sets it to None. The preflight reads that file, so every "complete" fixture needs one.
function torchVersion(cuda: boolean): string {
  return `__version__ = '2.13.0'\ncuda: Optional[str] = ${cuda ? "'12.6'" : 'None'}\n`;
}

function populate(root: string, cuda = true): void {
  for (const group of ASSET_GROUPS as AssetGroup[]) {
    for (const relative of group.files) write(root, relative);
  }
  write(root, `${CUDA_RUNTIME_DIR}/Lib/site-packages/torch/version.py`, torchVersion(cuda));
}

describe('installer asset preflight', () => {
  it('names every missing group and gives its recovery command', () => {
    const root = fixture();
    assert.equal(missingPackageInputs(root).length, ASSET_GROUPS.length);
    assert.throws(
      () => assertPackageInputs(root),
      /download-models[\s\S]*download-pyannote[\s\S]*build-pyannote-runtime/,
    );
  });

  it('passes only when every required file exists', () => {
    const root = fixture();
    populate(root);
    assert.doesNotThrow(() => assertPackageInputs(root));
  });

  it('rejects a venv-style runtime even when python.exe exists', () => {
    const root = fixture();
    populate(root);
    write(root, `${CUDA_RUNTIME_DIR}/pyvenv.cfg`, 'home = C:\\Python');
    assert.throws(() => assertPackageInputs(root), /pyvenv\.cfg[\s\S]*--force/);
  });

  // The folder is named -cuda but nothing stops a CPU tree being moved into it, and that
  // would ship a GPU add-on whose entire purpose cannot run.
  it('rejects a CPU torch wheel in the runtime the add-on is built from', () => {
    const root = fixture();
    populate(root, false);
    assert.throws(() => assertPackageInputs(root), /CPU torch[\s\S]*--force/);
  });

  // The runtime is a build input even though it is not packaged: without it there is no
  // add-on, and without the add-on speaker separation can never be switched on.
  it('still demands the CUDA runtime as a build input', () => {
    const groups = ASSET_GROUPS as AssetGroup[];
    assert.ok(groups.some((g) => g.files.some((f) => f.startsWith(CUDA_RUNTIME_DIR))));
  });
});

describe('packaged tree expectations', () => {
  // Asserted absent, not merely unused: a runtime that leaked into the installer is what
  // broke the NSIS build (2.8 GB payload against a ~2 GB mmap ceiling).
  it('forbids the Pyannote runtime and requires the extractor that installs it later', () => {
    assert.ok(UNPACKED_FORBIDDEN.includes('models/pyannote/runtime/python.exe'));
    assert.ok(UNPACKED_REQUIRED.includes('7za.exe'));
    assert.ok(!UNPACKED_REQUIRED.some((f: string) => f.includes('pyannote/runtime')));
  });

  it('requires both Whisper models, the Pyannote model and the worker', () => {
    for (const needle of [
      'whisper-large-v3-turbo/onnx/encoder_model_quantized.onnx',
      'whisper-medium-ONNX/onnx/encoder_model_quantized.onnx',
      'speaker-diarization-community-1/config.yaml',
      'app.asar.unpacked/out/main/pyannote-worker.py',
    ]) {
      assert.ok(UNPACKED_REQUIRED.some((f: string) => f.includes(needle)), needle);
    }
  });
});
