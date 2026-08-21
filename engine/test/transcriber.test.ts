// Guards the model-selection wiring in transcriber.ts.
//
// Source-level assertions rather than a live pipeline: loading two Whisper models costs
// a minute and ~1 GB each, which is not something the unit suite can pay on every run.
// The same technique the Pyannote worker is guarded with (diarizer.test.ts) — it cannot
// prove the model loads, but it does catch the specific regression that has no other
// symptom: a per-call model that is silently ignored.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

function readTranscriber(): string {
  return fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'transcribe', 'transcriber.ts'),
    'utf8',
  );
}

describe('Whisper model selection', () => {
  it('accepts a per-call model and hands it to the cache', () => {
    const source = readTranscriber();
    assert.match(source, /modelId\?: string/);
    assert.match(source, /getAsr\(opts\.modelId\)/);
  });

  // warmUp() resolves the default model at app boot (src/main/index.ts). A cache that
  // only checks "have I loaded anything yet" therefore never reloads, and a foreign
  // meeting would transcribe with turbo — producing the repetition-loop garbage this
  // whole feature exists to avoid, with no error raised anywhere.
  it('re-evaluates the cache when a different model is asked for', () => {
    const source = readTranscriber();
    const getAsr = source.slice(source.indexOf('function getAsr'), source.indexOf('export function warmUp'));

    assert.match(getAsr, /const key = /, 'önbellek bir anahtar türetmeli');
    assert.match(getAsr, /asrKey !== key/, 'model değişince önbellek yeniden kurulmalı');
    assert.doesNotMatch(
      getAsr,
      /if \(!asrPromise\) \{/,
      'salt "yüklendi mi" kontrolü warmUp() sonrası model değişimini yutar',
    );
    // The key must separate models; device/dtype ride along because they change the
    // loaded weights just as much.
    assert.match(getAsr, /\$\{model\}\|/);
  });

  // Both models are forced to Turkish. If the foreign path ever set opts.language the
  // feature would invert into "transcribe foreign audio in its own language".
  it('forces Turkish regardless of which model runs', () => {
    const source = readTranscriber();
    assert.match(source, /const language = opts\.language \?\? 'tr';/);
  });
});
