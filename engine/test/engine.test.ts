// Automated engine tests (Node's built-in runner: `npm test`).
//
// We can't assert exact transcription content, so these check the success/fail
// *shapes* of the public engine API: a real audio file transcribes to non-empty
// text/segments; bad inputs reject; removeAudio deletes and is safe on a missing
// file; analyze (a stub) rejects.
//
// The success-path tests need a real audio file. test_media/ is git-ignored (audio
// is large), so each developer drops their own file there — see README.md. When no
// audio file is present, those tests are SKIPPED rather than failing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { transcribe, transcribeToText, analyze } from '../index.ts';
import {removeAudio} from '../../utility/file-control.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// engine/test -> engine -> <root> -> test_media
const TEST_MEDIA_DIR = path.join(path.dirname(path.dirname(SCRIPT_DIR)), 'test_media');
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.webm', '.mp4']);

// First audio file in test_media/, or null if the folder is empty/missing.
function findTestAudio(): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(TEST_MEDIA_DIR);
  } catch {
    return null;
  }
  const audio = entries.find((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
  return audio ? path.join(TEST_MEDIA_DIR, audio) : null;
}

const AUDIO = findTestAudio();
// Whisper on CPU is slow, and each transcribe now also spawns the diarization
// worker (a second ONNX model over the same audio), so give these real end-to-end
// tests plenty of room.
const TRANSCRIBE_TIMEOUT = 600_000;

describe('transcription (needs an audio file in test_media/)', () => {
  const skip = AUDIO
    ? false
    : 'No audio file in test_media/ — add one (see README.md) to run these.';

  it('transcribeToText() returns non-empty plain text', { skip, timeout: TRANSCRIBE_TIMEOUT }, async () => {
    const text = await transcribeToText(AUDIO!);
    assert.equal(typeof text, 'string');
    assert.ok(text.trim().length > 0, 'expected non-empty transcription text');
  });

  it('transcribe() returns a success envelope with segments', { skip, timeout: TRANSCRIBE_TIMEOUT }, async () => {
    const result = await transcribe(AUDIO!);
    assert.equal(result.status, 'success');
    assert.ok(Array.isArray(result.segments));
    assert.ok(result.segments.length > 0, 'expected at least one segment');
  });
});

describe('error and edge cases (no audio file needed)', () => {
  it('transcribe() rejects for a non-existent file', async () => {
    await assert.rejects(() => transcribe(path.join(TEST_MEDIA_DIR, '__does_not_exist__.mp3')));
  });

  it('removeAudio() deletes the file and is safe to call again', async () => {
    const tmp = path.join(os.tmpdir(), `argus-remove-test-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, 'temp');
    assert.ok(fs.existsSync(tmp));

    await removeAudio(tmp);
    assert.ok(!fs.existsSync(tmp), 'file should be gone after removeAudio');

    // Second call on a missing file must not throw.
    await removeAudio(tmp);
  });

  it('analyze() rejects empty input (no LLM call needed)', async () => {
    await assert.rejects(() => analyze('   '), /boş|empty/i);
  });
});

// Live analysis needs a running Ollama server with the model pulled. Like the
// audio tests, we probe first and SKIP (not fail) when it's unavailable, so the
// suite stays green offline. When reachable we check the *shape* + connectivity
// of analyze() — not the content, which an LLM won't produce deterministically.
const OLLAMA_URL = process.env.ENGINE_LLM_URL || 'http://localhost:11434';
const ANALYZE_TIMEOUT = 120_000;

// True if Ollama answers /api/tags within a short timeout.
async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Probed once at load (top-level await, ESM) so the skip decision is ready when
// the describe block below is registered.
const OLLAMA_REACHABLE = await ollamaReachable();

describe('analysis (needs a running Ollama server)', () => {
  const skip = OLLAMA_REACHABLE
    ? false
    : `Ollama not reachable at ${OLLAMA_URL} — start it (ollama serve) and pull the model to run these.`;

  const SAMPLE =
    'Bugünkü toplantıda yeni ürün lansmanı konuşuldu. Ali pazarlama raporunu cuma günü ' +
    'gönderecek. Ayşe bütçe onayını takip edecek. Sonraki toplantı gelecek hafta yapılacak.';

  it('analyze() returns a success envelope with canonical markdown', { skip, timeout: ANALYZE_TIMEOUT }, async () => {
    const result = await analyze(SAMPLE);
    assert.equal(result.status, 'success');
    assert.equal(typeof result.markdown, 'string');
    assert.ok(result.markdown.trim().length > 0, 'expected non-empty analysis markdown');
    assert.equal((result.markdown.match(/^### /gm) ?? []).length, 9);
  });
});
