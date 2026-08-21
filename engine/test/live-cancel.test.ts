// The cancel contract of the live session. What matters here is not that the pipeline
// stops quickly — that is the abort signal's job, verified against a real recording —
// but that a cancelled meeting produces EXACTLY ONE terminal event and that it is never
// 'result'. 'result' is the only thing that reaches saveMeeting (src/main/ipc.ts), so a
// stray one would put a discarded meeting in the archive.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { liveSession } from '../live/session.ts';
import { configureLlm } from '../models.ts';

// Same closed-port trick as finalize.test.ts: the analysis must fail fast so the tests
// exercise the state machine rather than an LLM.
function pointAtClosedPort(): void {
  process.env.ENGINE_LLM_MAX_RETRIES = '0';
  configureLlm({ provider: 'ollama', model: 'test-model', host: 'http://127.0.0.1:1', apiKey: '' });
}

interface TerminalEvents {
  events: string[];
  stop: () => void;
}

function recordTerminalEvents(): TerminalEvents {
  const events: string[] = [];
  const onResult = (): void => void events.push('result');
  const onError = (): void => void events.push('error');
  const onCancelled = (): void => void events.push('cancelled');
  liveSession.on('result', onResult);
  liveSession.on('error', onError);
  liveSession.on('cancelled', onCancelled);
  return {
    events,
    stop: () => {
      liveSession.off('result', onResult);
      liveSession.off('error', onError);
      liveSession.off('cancelled', onCancelled);
    },
  };
}

afterEach(() => {
  configureLlm(null);
  delete process.env.ENGINE_LLM_MAX_RETRIES;
});

describe('LiveSession iptali', () => {
  it('emits cancelled — never result — for a meeting cancelled while finalizing', async () => {
    pointAtClosedPort();
    const terminal = recordTerminalEvents();

    liveSession.start({ meetingScope: 'group' });
    // A silent chunk is enough: the point is that the session has audio to finalize,
    // not what the ASR makes of it.
    liveSession.pushChunk(new Float32Array(16000));

    // stop() moves to 'finalizing' synchronously, which is where cancel() is honoured.
    const stopped = liveSession.stop(null);
    liveSession.cancel();
    await stopped;
    terminal.stop();

    assert.deepEqual(terminal.events, ['cancelled']);
  });

  it('ignores a cancel that arrives before Stop', async () => {
    pointAtClosedPort();
    const terminal = recordTerminalEvents();

    liveSession.start({ meetingScope: 'group' });
    liveSession.pushChunk(new Float32Array(16000));
    // Nothing is being finalized yet — the recording itself is stopped with Stop, and
    // treating this as a cancel would strand the session with no terminal event.
    liveSession.cancel();

    await liveSession.stop(null);
    terminal.stop();

    // Which of 'result' / 'error' lands depends on what the ASR heard (a synthetic
    // silent chunk transcribes to nothing, which is a legitimate 'Boş döküm' error).
    // The claim under test is the other one: the premature cancel changed nothing.
    assert.equal(terminal.events.length, 1);
    assert.notEqual(terminal.events[0], 'cancelled');
  });
});
