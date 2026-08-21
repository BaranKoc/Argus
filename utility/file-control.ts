import fs from 'node:fs/promises';

export async function removeAudio(audioPath: string): Promise<void> {
  try {
    await fs.unlink(audioPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

// Delete a single file. An already-missing file is a no-op (ENOENT swallowed) so a
// double-delete never throws. Caller validates/whitelists the path before it gets here
// (see meetings.ts deleteMeeting: id-shape check + join under the meetings dir).
export async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}