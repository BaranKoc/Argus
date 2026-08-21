// Side-effect module: runs the .env load at import time.
//
// It exists separately from env-boot.ts for one reason — ES module imports are
// evaluated in order and before any statement in the importing file, so this must
// be the FIRST import of index.ts to beat the engine's module graph. A plain
// function call in index.ts would run after the engine had already been evaluated.
//
// app.getAppPath()/getPath() are valid before app.whenReady().

import { app } from 'electron';
import { envCandidates, loadEnvFile } from './env-boot.ts';

loadEnvFile(envCandidates({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  userDataDir: app.getPath('userData'),
  execPath: process.execPath,
  resourcesPath: process.resourcesPath,
}));
