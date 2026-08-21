// The GPU add-on is 4.6 GB unpacked into the user's install folder, so the two rules
// worth pinning are the ones whose failure is expensive to undo: refusing the wrong
// archive BEFORE extracting, and never leaving a half-written runtime behind.
//
// Extraction itself is not exercised — that needs 7za and gigabytes — so these cover the
// pure logic and the guard rails around it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GpuAddonError, installGpuAddon, parsePercent } from './gpu-addon.ts';

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argus-gpu-addon-'));
}

describe('7za progress parsing', () => {
  it('reads the percentage off a progress line', () => {
    assert.equal(parsePercent(' 34% 1240 - Lib/site-packages/torch/lib/torch_cuda.dll'), 34);
    assert.equal(parsePercent('  0%'), 0);
    assert.equal(parsePercent('100% 4211'), 100);
  });

  it('ignores lines with no percentage of their own', () => {
    assert.equal(parsePercent('Extracting archive: Argus-GPU-Destegi.7z'), null);
    assert.equal(parsePercent(''), null);
    // A percent sign inside a file name is not progress.
    assert.equal(parsePercent('- Lib/site-packages/foo%bar.dll'), null);
  });
});

describe('GPU add-on installation guards', () => {
  it('refuses when the extractor is missing instead of failing mid-way', async () => {
    const root = fixture();
    await assert.rejects(
      () => installGpuAddon({
        sevenZip: path.join(root, 'yok', '7za.exe'),
        archivePath: path.join(root, 'addon.7z'),
        pyannoteDir: root,
      }),
      (error: Error) => error instanceof GpuAddonError && /Arşiv açıcı bulunamadı/.test(error.message),
    );
  });

  it('refuses a file that is not there', async () => {
    const root = fixture();
    const sevenZip = path.join(root, '7za.exe');
    fs.writeFileSync(sevenZip, 'stub');
    await assert.rejects(
      () => installGpuAddon({ sevenZip, archivePath: path.join(root, 'yok.7z'), pyannoteDir: root }),
      (error: Error) => error instanceof GpuAddonError && /bulunamadı/.test(error.message),
    );
  });

  // The existing runtime must survive a failed attempt: replacing it only after the new
  // one is fully unpacked is what keeps a botched install from taking working GPU
  // support with it.
  it('leaves an installed runtime untouched when the archive is rejected', async () => {
    const root = fixture();
    const sevenZip = path.join(root, '7za.exe');
    fs.writeFileSync(sevenZip, 'stub');
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime', 'python.exe'), 'mevcut');

    await assert.rejects(() => installGpuAddon({
      sevenZip,
      archivePath: path.join(root, 'yok.7z'),
      pyannoteDir: root,
    }));

    assert.equal(fs.readFileSync(path.join(root, 'runtime', 'python.exe'), 'utf8'), 'mevcut');
    assert.equal(fs.existsSync(path.join(root, 'runtime.installing')), false);
  });
});
