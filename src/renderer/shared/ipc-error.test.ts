import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ipcErrorMessage } from './ipc-error.ts';

describe('ipcErrorMessage', () => {
  // What Electron actually produced on screen before this existed.
  it('strips the remote-method wrapper and the doubled Error label', () => {
    const raw = new Error(
      "Error invoking remote method 'modelConfig:set': Error: Bu sağlayıcı için bir model adı girmelisiniz.",
    );
    assert.equal(ipcErrorMessage(raw), 'Bu sağlayıcı için bir model adı girmelisiniz.');
  });

  it('handles a nested rethrow', () => {
    const raw = new Error(
      "Error invoking remote method 'x': Error: Error: OpenAI için API anahtarı girmelisiniz.",
    );
    assert.equal(ipcErrorMessage(raw), 'OpenAI için API anahtarı girmelisiniz.');
  });

  it('leaves a plain message alone', () => {
    assert.equal(ipcErrorMessage(new Error('Bu işlem için yetkiniz yok.')), 'Bu işlem için yetkiniz yok.');
  });

  it('accepts something that is not an Error', () => {
    assert.equal(ipcErrorMessage('düz metin'), 'düz metin');
    assert.equal(ipcErrorMessage(42), '42');
  });

  // Stripping must never leave the user with nothing to read.
  it('falls back to the raw text rather than returning empty', () => {
    assert.equal(ipcErrorMessage(new Error('Error: ')), 'Error: ');
  });
});
