// Installs the GPU add-on — the CUDA Pyannote runtime — into the app's own folder.
//
// The runtime is 4.6 GB and cannot ride in the installer (makensis is 32-bit and cannot
// mmap a payload that size; see electron-builder.config.cjs), so it ships as a separate
// .7z the user gets alongside the installer and applies from inside the app. The app is
// the only thing that opens it, which is also why the archive is not self-extracting:
// there is no way for it to land somewhere the app will never look.
//
// Electron-free on purpose so it can be unit-tested: ipc.ts owns the dialog and the
// progress push, this file owns the rules. Same split as authorization.ts.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// The archive holds the runtime's CONTENTS at its root, so this is what a valid one
// always has. Checked before extracting: emptying 4.6 GB of the wrong archive into the
// install folder and then cleaning it up is far worse than refusing early.
const RUNTIME_MARKER = 'python.exe';

export interface GpuAddonProgress {
  percent: number;
}

export class GpuAddonError extends Error {}

function fail(message: string): never {
  throw new GpuAddonError(message);
}

function run(
  executable: string,
  args: string[],
  onLine?: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let out = '';
    let err = '';
    // 7za reports progress by rewriting one line with \r, so lines have to be split on
    // both terminators or the whole run arrives as a single unusable chunk at the end.
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      out += text;
      if (!onLine) return;
      pending += text;
      const parts = pending.split(/[\r\n]+/);
      pending = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.once('error', (error) => reject(new GpuAddonError(error.message)));
    child.once('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new GpuAddonError(err.trim() || out.trim() || `7za ${code} koduyla sonlandı.`));
    });
  });
}

export function parsePercent(line: string): number | null {
  // 7za's progress looks like " 34% 1234 - Lib/site-packages/torch/..." — take the first
  // percentage on the line and ignore anything that is part of a file name.
  const match = /(^|\s)(\d{1,3})%/.exec(line);
  if (!match) return null;
  const percent = Number(match[2]);
  return percent >= 0 && percent <= 100 ? percent : null;
}

// Reads the archive's table of contents without unpacking it.
export async function isRuntimeArchive(sevenZip: string, archivePath: string): Promise<boolean> {
  const listing = await run(sevenZip, ['l', '-ba', '-slt', archivePath]);
  return listing.split(/\r?\n/).some((line) => {
    const match = /^Path = (.+)$/.exec(line.trim());
    return match ? match[1].replace(/\\/g, '/').toLowerCase() === RUNTIME_MARKER : false;
  });
}

export interface InstallGpuAddonOptions {
  sevenZip: string;
  archivePath: string;
  // <install>/resources/models/pyannote — the runtime lands in a `runtime` folder here,
  // which is exactly where SettingsStore probes for it.
  pyannoteDir: string;
  onProgress?: (progress: GpuAddonProgress) => void;
}

export async function installGpuAddon(options: InstallGpuAddonOptions): Promise<string> {
  const { sevenZip, archivePath, pyannoteDir, onProgress } = options;

  if (!fs.existsSync(sevenZip)) fail('Arşiv açıcı bulunamadı; uygulama kurulumu eksik olabilir.');
  if (!fs.existsSync(archivePath)) fail('Seçilen dosya bulunamadı.');

  if (!(await isRuntimeArchive(sevenZip, archivePath))) {
    fail('Seçilen arşiv GPU eklentisi değil. Installer ile birlikte verilen Argus-GPU-Destegi.7z dosyasını seçin.');
  }

  const target = path.join(pyannoteDir, 'runtime');
  // Extract to a sibling first: a half-written runtime left in place would make the app
  // report GPU support it cannot deliver, and the failure would surface at the end of a
  // meeting rather than here.
  const staging = `${target}.installing`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  try {
    await run(
      sevenZip,
      ['x', archivePath, `-o${staging}`, '-y', '-bsp1'],
      (line) => {
        const percent = parsePercent(line);
        if (percent != null) onProgress?.({ percent });
      },
    );

    if (!fs.existsSync(path.join(staging, RUNTIME_MARKER))) {
      fail('Arşiv açıldı ama beklenen çalışma zamanı çıkmadı.');
    }

    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
