// Finalize's two degraded contracts, both about NOT losing a recorded meeting:
//
//   1. the analysis failed -> the transcript still comes back, with analysisError set,
//      because only a returned result ever reaches saveMeeting (src/main/ipc.ts);
//   2. the meeting was cancelled -> nothing comes back at all, because the user asked
//      for it to be discarded. Cancellation therefore outranks rule 1.
//
// The analysis failure is produced by pointing the analyzer at a closed port rather
// than by mocking analyzeText: finalize imports the module singleton, and a test that
// stubbed it would stop covering the very wiring (analyzer -> client -> provider error)
// this contract depends on. Port 1 refuses immediately, so nothing here waits on a
// timeout.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { finalize } from '../live/finalize.ts';
import { configureLlm } from '../models.ts';
import type { Segment } from '../transcribe/transcriber.ts';

const SEGMENTS: Segment[] = [
  { text: 'Bütçeyi haftaya konuşalım.', start: 0, end: 2 },
  { text: 'Tamam, cuma günü karar veriyoruz.', start: 2, end: 4 },
];

// audioPath null keeps diarization out of it: these tests are about the analysis step,
// and spawning Pyannote would make them depend on an installed GPU runtime.
const AUDIO_PATH = null;

function pointAtClosedPort(): void {
  process.env.ENGINE_LLM_MAX_RETRIES = '0';
  configureLlm({ provider: 'ollama', model: 'test-model', host: 'http://127.0.0.1:1', apiKey: '' });
}

afterEach(() => {
  configureLlm(null);
  delete process.env.ENGINE_LLM_MAX_RETRIES;
});

describe('finalize: analiz başarısız olduğunda döküm korunur', () => {
  it('returns the transcript with analysisError instead of throwing', async () => {
    pointAtClosedPort();

    const result = await finalize(SEGMENTS, AUDIO_PATH);

    assert.equal(result.analysis, undefined);
    assert.ok(result.analysisError, 'analiz hatası mesajı bekleniyordu');
    assert.match(result.analysisError!, /Ollama/);
    assert.equal(result.segments.length, SEGMENTS.length);
    assert.equal(result.segments[0].text, SEGMENTS[0].text);
    // The WAV-save-failed flag is orthogonal and must survive the rescue path.
    assert.equal(result.speakersDegraded, true);
  });

  it('still throws on an empty transcript — there is nothing to save', async () => {
    pointAtClosedPort();

    await assert.rejects(
      finalize([{ text: '   ', start: 0, end: 1 }], AUDIO_PATH),
      /Boş döküm/,
    );
  });
});

describe('finalize: iptal, dökümü kurtarma davranışını ezer', () => {
  it('rejects instead of returning a transcript when the signal is aborted', async () => {
    pointAtClosedPort();

    await assert.rejects(
      finalize(SEGMENTS, AUDIO_PATH, { signal: AbortSignal.abort() }),
      (error: Error) => error.name === 'AbortError',
    );
  });
});
