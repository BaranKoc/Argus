// Developer-only: builds the Python runtime that ships inside the distributable.
//
// `download-pyannote` makes a venv, which is fine on the machine that created it and
// useless anywhere else: pyvenv.cfg records the absolute path of the base install it
// borrows the interpreter and stdlib from, and no end user has that path. So the
// package cannot ship that tree. This tool instead lays down a python-build-standalone
// interpreter — a complete, relocatable CPython — and installs Pyannote into it, so the
// result runs from wherever NSIS drops it.
//
// Output goes to build/pyannote-runtime-cuda and is picked up by the Full installer
// (electron-builder.full.cjs). It is deliberately NOT models/pyannote/runtime: that one
// stays the developer venv the manual test runs against.
//
//   npm run build-pyannote-runtime -w engine                    # CUDA — what ships
//   npm run build-pyannote-runtime -w engine -- --cpu           # CPU twin, measurement only
//   npm run build-pyannote-runtime -w engine -- --force         # discard and rebuild
//   npm run build-pyannote-runtime -w engine -- --tag 20250818  # pin a CPython release
//
// CUDA is the default because speaker separation is now GPU-only in the product: the CPU
// path was measured at 11.7 min for a 24.5 min meeting (vs 1.0 min on a RTX 4060) with a
// 14.7 GB RSS peak. --cpu still builds the CPU tree next to it, because diarize-bench
// needs both to keep that comparison reproducible.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODELS_DIR, PYANNOTE_MODEL_VERSION, SAMPLE_RATE, RESULT_MARKER } from '../diarization-config.ts';
import { downloadWithResume } from './fetch-file.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const REQUIREMENTS_PATH = path.join(ROOT, 'resources', 'pyannote', 'requirements.txt');
const CUDA_REQUIREMENTS_PATH = path.join(ROOT, 'resources', 'pyannote', 'requirements-cuda.txt');
const WORKER_PATH = path.join(ROOT, 'engine', 'diarize', 'pyannote-worker.py');
const MODEL_DIR = path.join(MODELS_DIR, 'pyannote', PYANNOTE_MODEL_VERSION);
// Both names say what is inside them. The old flavour-less build/pyannote-runtime is
// retired: once the product went GPU-only, a bare name could not tell a shippable CUDA
// tree from a CPU one that would silently ship a feature that no longer works.
const DEFAULT_CUDA_OUT = path.join(ROOT, 'build', 'pyannote-runtime-cuda');
const DEFAULT_CPU_OUT = path.join(ROOT, 'build', 'pyannote-runtime-cpu');

const RELEASE_API = 'https://api.github.com/repos/astral-sh/python-build-standalone/releases';
const DEFAULT_SERIES = '3.13';

// python-build-standalone names every asset <triple>-install_only.tar.gz. install_only
// is the runtime-shaped build (no build artifacts, no debug symbols) and the one uv
// ships, so it is what we want here.
const TRIPLES: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

// Windows 10 1803+ ships bsdtar as System32\tar.exe, which understands drive letters.
// Prefer it by absolute path so a Git-for-Windows GNU tar earlier on PATH can't win.
function tarBinary(): string {
  if (process.platform !== 'win32') return 'tar';
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(system32) ? system32 : 'tar';
}

function interpreter(runtimeDir: string): string {
  return process.platform === 'win32'
    ? path.join(runtimeDir, 'python.exe')
    : path.join(runtimeDir, 'bin', 'python3');
}

// torch is a multi-GB wheel and pip's 15s default socket timeout gives up on a slow
// link long before the transfer is actually dead. Retries plus a long timeout turn a
// flaky download into a slow one; pip's HTTP cache means a re-run resumes rather than
// starting over.
const PIP_NETWORK_ARGS = ['--retries', '10', '--timeout', '120'];

function run(command: string, args: string[], label: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      // HF_HUB_OFFLINE stays off here: pip needs the network. The worker sets it
      // itself at run time so a packaged app never reaches out.
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.once('error', (error) => reject(new Error(`${label} başlatılamadı: ${error.message}`)));
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label} ${code ?? 'bilinmeyen'} koduyla sonlandı.`))));
  });
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.once('error', (error) => reject(new Error(error.message)));
    child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`çıkış kodu ${code ?? 'bilinmeyen'}`))));
  });
}

interface Asset { name: string; browser_download_url: string }
interface Release { tag_name: string; assets: Asset[] }

// Releases are tagged by date and each carries every CPython series, so "latest release"
// plus a name filter is the stable way to ask for "newest 3.13 for this platform"
// without pinning a tag that goes stale.
async function resolveAsset(series: string, tag?: string): Promise<{ tag: string; url: string; name: string }> {
  const triple = TRIPLES[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error(`Desteklenmeyen platform: ${process.platform}-${process.arch}`);

  const url = tag ? `${RELEASE_API}/tags/${tag}` : `${RELEASE_API}/latest`;
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`CPython sürüm listesi alınamadı: HTTP ${res.status} ${res.statusText}`);
  const release = (await res.json()) as Release;

  const suffix = `-${triple}-install_only.tar.gz`;
  const matches = release.assets.filter((a) => a.name.startsWith(`cpython-${series}.`) && a.name.endsWith(suffix));
  if (matches.length === 0) {
    throw new Error(`${release.tag_name} sürümünde ${series} / ${triple} için install_only paketi yok.`);
  }
  // Several patch levels can share a release; take the highest.
  matches.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const chosen = matches[matches.length - 1];
  return { tag: release.tag_name, url: chosen.browser_download_url, name: chosen.name };
}

async function installRuntime(outDir: string, series: string, tag?: string): Promise<void> {
  const asset = await resolveAsset(series, tag);
  console.log(`CPython ${series} (${asset.tag}) indiriliyor: ${asset.name}`);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-cpython-'));
  try {
    const archive = path.join(staging, asset.name);
    await downloadWithResume(asset.url, archive, asset.name);

    console.log('Arşiv açılıyor...');
    // Run from inside the staging directory with a bare filename. GNU tar reads
    // "C:\..." as a remote host:path spec and dies with "Cannot connect to C",
    // and a Git-for-Windows install puts its GNU tar ahead of Windows' own bsdtar
    // on PATH — so neither the absolute path nor the resolved binary can be assumed.
    await run(tarBinary(), ['-xzf', asset.name], 'Arşiv açma', staging);

    // install_only tarballs unpack into a single `python/` directory.
    const extracted = path.join(staging, 'python');
    if (!fs.existsSync(extracted)) throw new Error('Arşiv beklenen python/ klasörünü içermiyor.');
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(extracted, outDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// A synthetic 16 kHz mono 16-bit PCM WAV — the exact shape the renderer records and the
// only thing the worker's load_recorded_wav accepts. Alternating tone bursts give the
// pipeline real energy to segment; the point is that torch, pyannote and the Community-1
// checkpoint all load and run, not that the speaker labels mean anything.
function writeSmokeWav(dest: string, seconds = 8): void {
  const frames = SAMPLE_RATE * seconds;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const hz = Math.floor(t) % 2 === 0 ? 140 : 220;
    const envelope = 0.4 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    const value = Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(2 * Math.PI * hz * 2.5 * t);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * envelope * 32767))), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  fs.writeFileSync(dest, Buffer.concat([header, data]));
}

async function verify(python: string, cuda: boolean): Promise<void> {
  console.log('Çalışma zamanı doğrulanıyor...');
  // torch.version.cuda is the assertion, NOT torch.cuda.is_available(): the first says
  // "this wheel was built with CUDA", which is the property we are packaging, while the
  // second also needs a GPU in the machine doing the build. Asserting availability would
  // make the runtime unbuildable on a GPU-less build agent. pip picking the wrong wheel
  // is silent otherwise, and a CPU tree shipped as the CUDA one would break diarization
  // for every user of the Full installer.
  await run(python, [
    '-c',
    'import importlib.metadata, torch; assert importlib.metadata.version("pyannote-audio") == "4.0.0";'
    + ` assert (torch.version.cuda is not None) is ${cuda ? 'True' : 'False'}, f"beklenen CUDA wheel=${cuda ? 'evet' : 'hayir'}, torch {torch.__version__}";`
    + ' print(f"pyannote.audio 4.0.0 / torch {torch.__version__} / cuda wheel={torch.version.cuda} / bu makinede GPU={torch.cuda.is_available()}")',
  ], 'Doğrulama');

  if (!fs.existsSync(path.join(MODEL_DIR, 'config.yaml'))) {
    console.warn(`⚠ Community-1 modeli yok (${MODEL_DIR}) — worker denemesi atlandı.`);
    console.warn('  "npm run download-pyannote -w engine" ile indirip bu aracı tekrar çalıştırın.');
    return;
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-diar-smoke-'));
  try {
    const wav = path.join(staging, 'smoke.wav');
    writeSmokeWav(wav);
    console.log('Pyannote worker sentetik bir kayıtla çalıştırılıyor (birkaç dakika sürebilir)...');
    // 'auto', not 'cuda': the product's strict cuda mode refuses to run without a GPU,
    // and this smoke test is about "does pyannote load and produce a result line at all",
    // which must still pass on a build agent that has the wheel but no card.
    const stdout = await capture(python, [WORKER_PATH, wav, MODEL_DIR, cuda ? 'auto' : 'cpu']);
    if (!stdout.split(/\r?\n/).some((line) => line.startsWith(RESULT_MARKER))) {
      throw new Error('Worker sonuç satırı üretmedi.');
    }
    console.log('Worker sonuç satırını üretti — çalışma zamanı hazır.');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

// pip leaves compiled bytecode for every module it touched. It is regenerated on demand
// and only inflates the installer.
function dropPycache(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === '__pycache__') fs.rmSync(full, { recursive: true, force: true });
    else dropPycache(full);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Kullanım: npm run build-pyannote-runtime -w engine [-- --cpu] [--out <dizin>] [--tag <sürüm>] [--series 3.13] [--force] [--skip-verify]');
    return;
  }
  if (!fs.existsSync(REQUIREMENTS_PATH)) throw new Error(`Gereksinim dosyası bulunamadı: ${REQUIREMENTS_PATH}`);

  const cuda = !process.argv.includes('--cpu');
  if (cuda && !fs.existsSync(CUDA_REQUIREMENTS_PATH)) {
    throw new Error(`CUDA gereksinim dosyası bulunamadı: ${CUDA_REQUIREMENTS_PATH}`);
  }

  const outDir = path.resolve(option('--out') ?? (cuda ? DEFAULT_CUDA_OUT : DEFAULT_CPU_OUT));
  const series = option('--series') ?? DEFAULT_SERIES;
  const python = interpreter(outDir);

  if (process.argv.includes('--force')) fs.rmSync(outDir, { recursive: true, force: true });
  if (!fs.existsSync(python)) await installRuntime(outDir, series, option('--tag'));
  else console.log(`Mevcut çalışma zamanı kullanılıyor: ${outDir} (--force ile sıfırdan kurun)`);

  // Order matters: torch first from the CUDA index, so the pyannote.audio resolve below
  // finds its torch dependency already satisfied and never reaches for the PyPI CPU wheel.
  if (cuda) {
    console.log('CUDA torch yükleniyor (~2.5 GB, uzun sürer)...');
    await run(python, ['-m', 'pip', 'install', ...PIP_NETWORK_ARGS, '--requirement', CUDA_REQUIREMENTS_PATH], 'pip install (cuda)');
  }

  console.log('Pyannote gereksinimleri yükleniyor (uzun sürer)...');
  // With --cpu the plain PyPI torch wheel on Windows is already the CPU build; with the
  // default the CUDA install above has already satisfied torch, so this resolve only adds
  // pyannote itself. verify() asserts which wheel landed, so neither can slip in unnoticed.
  await run(python, ['-m', 'pip', 'install', ...PIP_NETWORK_ARGS, '--requirement', REQUIREMENTS_PATH], 'pip install');

  dropPycache(outDir);
  if (!process.argv.includes('--skip-verify')) await verify(python, cuda);

  const gb = (dirSize(outDir) / (1024 ** 3)).toFixed(2);
  console.log(`\nTaşınabilir çalışma zamanı hazır: ${outDir} (${gb} GB)`);
  if (cuda) {
    console.log('"npm run dist:full" artık konuşmacı ayrımını da pakete dahil edecek.');
  } else {
    console.log('Bu CPU çalışma zamanı paketlenmez; yalnız ölçüm içindir:');
    console.log('  npm run diarize-bench -w engine -- --files S6-C.mp3 --devices cpu,cuda');
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Çalışma zamanı hazırlama başarısız oldu.');
  process.exitCode = 1;
});
