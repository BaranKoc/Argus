// The meeting language is the first per-recording option the renderer sends to main.
// Everything else at live:start is derived in main from SettingsStore, so this is the
// one payload on that channel that a compromised or out-of-date renderer could shape —
// hence a validation test rather than trusting the preload's types, which do not exist
// at runtime.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMeetingLanguage } from './meeting-language.ts';

describe('live:start meeting language', () => {
  it('accepts the two languages the engine knows', () => {
    assert.equal(parseMeetingLanguage({ meetingLanguage: 'turkish' }), 'turkish');
    assert.equal(parseMeetingLanguage({ meetingLanguage: 'foreign' }), 'foreign');
  });

  // Not a default. A meeting recorded in the wrong language produces a transcript that
  // reads as broken with nothing to blame it on, so the disagreement has to surface at
  // the boundary where it can still be fixed.
  it('rejects anything else instead of falling back to Turkish', () => {
    for (const payload of [
      undefined,
      null,
      {},
      { meetingLanguage: 'tr' },
      { meetingLanguage: 'en' },
      { meetingLanguage: '' },
      { meetingLanguage: true },
      { meetingLanguage: ['foreign'] },
      'foreign',
    ]) {
      assert.throws(() => parseMeetingLanguage(payload), /Geçersiz toplantı dili/, String(payload));
    }
  });
});
