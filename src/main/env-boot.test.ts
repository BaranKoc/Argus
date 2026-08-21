import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { envCandidates, loadEnvFile, resolveEnvPath } from './env-boot.ts';

const LOCATIONS = {
  isPackaged: false,
  appPath: path.join('C:', 'repo'),
  userDataDir: path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'app'),
  execPath: path.join('C:', 'Program Files', 'app', 'app.exe'),
  resourcesPath: path.join('C:', 'Program Files', 'app', 'resources'),
};

describe('envCandidates', () => {
  it('prefers the engine/.env the CLI commands already use in development', () => {
    assert.deepEqual(envCandidates(LOCATIONS), [
      path.join('C:', 'repo', 'engine', '.env'),
      path.join('C:', 'repo', '.env'),
    ]);
  });

  it('looks beside the installed exe first when packaged', () => {
    assert.deepEqual(envCandidates({ ...LOCATIONS, isPackaged: true }), [
      path.join('C:', 'Program Files', 'app', '.env'),
      LOCATIONS.userDataDir + path.sep + '.env',
      path.join('C:', 'Program Files', 'app', 'resources', '.env'),
    ]);
  });
});

describe('resolveEnvPath', () => {
  it('returns the first candidate that exists, not merely the first listed', () => {
    const found = resolveEnvPath(['a', 'b', 'c'], (p) => p === 'b' || p === 'c');
    assert.equal(found, 'b');
  });

  it('returns null when nothing exists, so the app falls back to defaults', () => {
    assert.equal(resolveEnvPath(['a', 'b'], () => false), null);
  });
});

describe('loadEnvFile', () => {
  it('is a no-op without a .env — a missing file is normal, not an error', () => {
    assert.equal(loadEnvFile(['nope'], () => false), null);
  });
});
