import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RecordingGuard } from './authorization.ts';

describe('RecordingGuard', () => {
  it('accepts continuation only during an active recording', () => {
    const guard = new RecordingGuard();
    assert.throws(() => guard.requireActive(), /Aktif kayıt/);
    guard.start(() => undefined);
    assert.doesNotThrow(() => guard.requireActive());
    guard.finish();
    assert.throws(() => guard.requireActive(), /Aktif kayıt/);
  });

  it('does not activate when start fails and rejects a second start', () => {
    const guard = new RecordingGuard();
    assert.throws(() => guard.start(() => { throw new Error('start failed'); }), /start failed/);
    assert.equal(guard.hasActiveRecording(), false);
    guard.start(() => undefined);
    assert.throws(() => guard.start(() => undefined), /aktif bir kayıt/);
  });
});
