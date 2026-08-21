// Temp-audio storage. The live recorder's Stop saves a WAV here; the renderer holds
// the returned path and the main process deletes it after the result is delivered
// (KVKK auto-delete, sequenced in ipc.ts).
//
// In dev we use the project's temp/ folder (already git-ignored) so recordings are
// easy to inspect; when packaged there is no writable project dir, so we fall back
// to userData/temp.

import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// out/main/temp.js -> project root is two levels up. Used only in dev.
const PROJECT_TEMP = path.resolve(SCRIPT_DIR, '..', '..', 'temp');

function tempDir(): string {
  return app.isPackaged ? path.join(app.getPath('userData'), 'temp') : PROJECT_TEMP;
}

async function ensureTempDir(): Promise<string> {
  const dir = tempDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Files tracked so we can best-effort clean up anything still around on quit.
const tracked = new Set<string>();

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Write recorded WAV bytes to a new temp file. Returns its path.
export async function saveRecording(bytes: ArrayBuffer): Promise<string> {
  const dir = await ensureTempDir();
  const dest = path.join(dir, `recording-${stamp()}.wav`);
  await fs.writeFile(dest, Buffer.from(bytes));
  tracked.add(dest);
  return dest;
}

export function untrack(filePath: string): void {
  tracked.delete(filePath);
}

// Best-effort cleanup of any temp files still tracked (e.g. never explicitly
// deleted by the user) — called on app quit so recordings don't accumulate.
export async function cleanupTracked(): Promise<void> {
  await Promise.all(
    [...tracked].map((f) => fs.unlink(f).catch(() => undefined)),
  );
  tracked.clear();
}
