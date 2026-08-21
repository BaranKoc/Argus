import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ENGINE_ROOT = path.resolve(import.meta.dirname, '..');
describe('developer Pyannote provisioning command', () => {
  it('is registered, offers a non-network help path, and keeps tokens off the command line', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.match(pkg.scripts['download-pyannote'], /download\/download-pyannote\.ts/);

    const source = fs.readFileSync(path.join(ENGINE_ROOT, 'download', 'download-pyannote.ts'), 'utf8');
    assert.doesNotMatch(source, /--token(?:\s|$)/);
    assert.match(source, /--token-stdin/);
    assert.match(source, /snapshot_download/);
    assert.match(source, /\]\.join\('\\n'\)/);
    assert.match(source, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'argus-pyannote-'/);
    assert.match(source, /shutil\.copytree/);
    assert.doesNotMatch(source, /HF_TOKEN/);

    const output = execFileSync(process.execPath, ['download/download-pyannote.ts', '--help'], {
      cwd: ENGINE_ROOT,
      encoding: 'utf8',
    });
    assert.match(output, /Kullanım:/);
  });
});
