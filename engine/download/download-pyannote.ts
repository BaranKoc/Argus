// Developer-only provisioning for the local Pyannote Community-1 assets.
// It never persists or logs the Hugging Face token. The desktop application only
// reads the completed models/pyannote directory and never downloads at runtime.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODELS_DIR, PYANNOTE_MODEL_VERSION } from '../diarization-config.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PYANNOTE_ROOT = path.join(MODELS_DIR, 'pyannote');
const RUNTIME_DIR = path.join(PYANNOTE_ROOT, 'runtime');
const MODEL_DIR = path.join(PYANNOTE_ROOT, PYANNOTE_MODEL_VERSION);
const REQUIREMENTS_PATH = path.resolve(SCRIPT_DIR, '..', '..', 'resources', 'pyannote', 'requirements.txt');
const RUNTIME_PYTHON = path.join(RUNTIME_DIR, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function commandExists(command: string): string | null {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const first = result.stdout.split(/\r?\n/).find(Boolean)?.trim();
  return first && fs.existsSync(first) ? first : null;
}

function bootstrapPython(): string {
  const explicit = option('--python');
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error(`--python yolu bulunamadı: ${resolved}`);
  }
  const detected = commandExists(process.platform === 'win32' ? 'python.exe' : 'python3')
    ?? commandExists('python');
  if (!detected) throw new Error('Python bulunamadı. Python yolunu --python ile verin.');
  return detected;
}

function run(command: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_XET: '1' },
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.once('error', () => reject(new Error('Pyannote hazırlama işlemi başlatılamadı.')));
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Pyannote hazırlama işlemi ${code ?? 'bilinmeyen'} koduyla sonlandı.`)));
    child.stdin.end(input);
  });
}

function readHiddenToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error('Etkileşimli terminal gerekli. Otomasyon için belirteci standart girdiden --token-stdin ile verin.');
  }
  process.stdout.write('Hugging Face erişim belirteci (gizli): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let token = '';
    const done = (error?: Error): void => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(token.trim());
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003') return done(new Error('İşlem iptal edildi.'));
        if (char === '\b' || char === '\u007f') token = token.slice(0, -1);
        else token += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function readToken(): Promise<string> {
  if (process.argv.includes('--token-stdin')) {
    let token = '';
    for await (const chunk of process.stdin) token += chunk.toString();
    return token.trim();
  }
  return readHiddenToken();
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Kullanım: npm run download-pyannote [-- --python <python-yolu>] [--token-stdin]');
    return;
  }
  if (!fs.existsSync(REQUIREMENTS_PATH)) throw new Error(`Gereksinim dosyası bulunamadı: ${REQUIREMENTS_PATH}`);

  fs.mkdirSync(PYANNOTE_ROOT, { recursive: true });
  const python = fs.existsSync(RUNTIME_PYTHON) ? RUNTIME_PYTHON : bootstrapPython();
  if (!fs.existsSync(RUNTIME_PYTHON)) {
    console.log('Yerel Python ortamı hazırlanıyor...');
    await run(python, ['-m', 'venv', RUNTIME_DIR]);
  }

  console.log('Pyannote gereksinimleri yükleniyor...');
  await run(RUNTIME_PYTHON, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--requirement', REQUIREMENTS_PATH]);
  await run(RUNTIME_PYTHON, [
    '-c',
    'import importlib.metadata; import huggingface_hub; assert importlib.metadata.version("pyannote-audio") == "4.0.0"; print("Pyannote runtime verified.")',
  ]);

  if (fs.existsSync(path.join(MODEL_DIR, 'config.yaml'))) {
    console.log(`Pyannote Community-1 zaten mevcut: ${MODEL_DIR}`);
    return;
  }

  console.log('Devam etmeden önce Hugging Face üzerinde Community-1 kullanım koşullarını kabul edin.');
  const token = await readToken();
  if (!token) throw new Error('Hugging Face erişim belirteci gerekli.');

  // Hugging Face's local_dir cache adds several nested components. On Windows the
  // resulting temporary filename can exceed what its downloader can create under
  // this project's long path, so download into a short temp cache and copy only the
  // completed snapshot into models/.
  const stagingCache = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-pyannote-'));
  const installer = [
    'from huggingface_hub import snapshot_download',
    'import shutil, sys',
    'token = sys.stdin.readline().strip()',
    'if not token: raise RuntimeError("missing Hugging Face token")',
    'snapshot = snapshot_download(repo_id="pyannote/speaker-diarization-community-1", cache_dir=sys.argv[2], token=token, max_workers=1)',
    'shutil.copytree(snapshot, sys.argv[1], dirs_exist_ok=True)',
  ].join('\n');
  console.log('Pyannote Community-1 indiriliyor...');
  try {
    await run(RUNTIME_PYTHON, ['-c', installer, MODEL_DIR, stagingCache], `${token}\n`);
  } finally {
    fs.rmSync(stagingCache, { recursive: true, force: true });
  }
  console.log(`Pyannote hazır: ${PYANNOTE_ROOT}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Pyannote hazırlama işlemi başarısız oldu.');
  process.exitCode = 1;
});
