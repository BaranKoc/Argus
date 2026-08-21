import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('Main build assets', () => {
  const config = fs.readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf8');

  it('copies the isolated Python worker beside the compiled Electron main entry', () => {
    assert.match(config, /copy-pyannote-worker/);
    assert.match(config, /engine\/diarize\/pyannote-worker\.py/);
    assert.match(config, /out\/main\/pyannote-worker\.py/);
  });

  // correct.ts resolves the dictionary from beside its own module and swallows a
  // read failure, so a missing copy shows up as silently uncorrected transcripts
  // rather than an error. Assert the copy instead of trusting the output.
  it('copies the domain dictionary beside the compiled Electron main entry', () => {
    assert.match(config, /engine\/transcribe\/domain-dictionary\.json/);
    assert.match(config, /out\/main\/domain-dictionary\.json/);
  });
});
