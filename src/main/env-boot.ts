// Loads a .env into process.env before the engine module graph is evaluated.
//
// The engine's CLI commands get this from Node's --env-file-if-exists flag
// (engine/package.json), but Electron is not launched with that flag, so without
// this the app would only ever see getLlmConfig()'s compiled-in defaults and
// editing .env would appear to do nothing.
//
// Pure and electron-free so it unit-tests under plain `node --test`, same as
// settings.ts; env-boot-run.ts is the thin Electron-aware caller.

import fs from 'node:fs';
import path from 'node:path';

export interface EnvLocations {
  isPackaged: boolean;
  appPath: string;
  userDataDir: string;
  execPath: string;
  resourcesPath: string;
}

// First existing candidate wins. Packaged: beside the installed .exe is where an
// operator would naturally drop the file, with userData as the writable fallback
// for a machine where the install directory is locked down. Development: the same
// engine/.env the CLI commands already use, so there is one file to edit, not two.
export function envCandidates(locations: EnvLocations): string[] {
  if (!locations.isPackaged) {
    return [
      path.join(locations.appPath, 'engine', '.env'),
      path.join(locations.appPath, '.env'),
    ];
  }
  return [
    path.join(path.dirname(locations.execPath), '.env'),
    path.join(locations.userDataDir, '.env'),
    path.join(locations.resourcesPath, '.env'),
  ];
}

export function resolveEnvPath(candidates: string[], exists = fs.existsSync): string | null {
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export function loadEnvFile(candidates: string[], exists = fs.existsSync): string | null {
  const found = resolveEnvPath(candidates, exists);
  if (!found) return null;

  // process.loadEnvFile lands in Node 20.12; Electron 33 ships 20.18. Guarded so a
  // downgrade degrades to "no .env" instead of crashing the app at startup.
  if (typeof process.loadEnvFile !== 'function') {
    console.warn(`[env] ${found} atlandı — process.loadEnvFile bu Node sürümünde yok`);
    return null;
  }

  try {
    process.loadEnvFile(found);
    // Path only. The file holds ENGINE_LLM_API_KEY; its values never reach a log.
    console.log(`[env] yüklendi: ${found}`);
    return found;
  } catch (error) {
    console.warn(`[env] ${found} okunamadı: ${(error as Error).message}`);
    return null;
  }
}
