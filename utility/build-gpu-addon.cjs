// Packs the CUDA Pyannote runtime into the archive the app installs into itself.
//
// It is NOT in the installer because it cannot be: makensis.exe is 32-bit and could not
// mmap the payload, which measured 2.8 GB against a ~2 GB ceiling. Trimming does not
// close that — torch_cuda.dll, cublasLt and cudnn_engines_precompiled are mandatory and
// total ~2 GB on their own. See electron-builder.config.cjs.
//
// A plain .7z rather than a self-extracting .exe, deliberately: it cannot be run, so it
// cannot install itself into some folder the app will never look in. The app is the only
// thing that opens it (src/main/gpu-addon.ts).
//
//   node utility/build-gpu-addon.cjs [--force]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { path7za } = require('7zip-bin');
const { CUDA_RUNTIME_DIR } = require('./package-assets.cjs');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, CUDA_RUNTIME_DIR);
const DIST = path.join(ROOT, 'dist');
// Fixed name, no version: the app tells the user what to look for, and a version in the
// filename would have to be kept in sync with nothing that reads it.
const ARCHIVE = path.join(DIST, 'Argus-GPU-Destegi.7z');

function fail(message) {
  console.error(`[gpu-eklentisi] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(RUNTIME, 'python.exe'))) {
  fail(`CUDA runtime yok: ${RUNTIME}\nÖnce: npm run build-pyannote-runtime -w engine`);
}

// Rebuilding 2.2 GB on every dist run would make the build loop unusable, and the runtime
// changes only when someone rebuilds it on purpose.
function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const stat = fs.statSync(path.join(entry.parentPath, entry.name));
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

if (!process.argv.includes('--force') && fs.existsSync(ARCHIVE)) {
  if (fs.statSync(ARCHIVE).mtimeMs >= newestMtime(RUNTIME)) {
    const gb = (fs.statSync(ARCHIVE).size / 1024 ** 3).toFixed(2);
    console.log(`[gpu-eklentisi] Güncel arşiv kullanılıyor: ${ARCHIVE} (${gb} GB)`);
    console.log('[gpu-eklentisi] Yeniden üretmek için: npm run build-gpu-addon -- --force');
    process.exit(0);
  }
}

fs.mkdirSync(DIST, { recursive: true });
fs.rmSync(ARCHIVE, { force: true });

console.log(`[gpu-eklentisi] Arşivleniyor (~2 GB, birkaç dakika sürer): ${ARCHIVE}`);
// The runtime's CONTENTS go in at the archive root (python.exe, Lib/, ...), not the
// folder itself: the app then extracts straight into models/pyannote/runtime and never
// has to rename anything, and gpu-addon.ts can vet an archive by looking for python.exe
// in its listing. -mx=5 rather than 9: the extra minutes buy well under a percent on
// DLLs this large.
const result = spawnSync(
  path7za,
  ['a', '-t7z', '-mx=5', '-bso0', '-bsp1', ARCHIVE, path.join(RUNTIME, '*')],
  { stdio: ['ignore', 'inherit', 'inherit'], cwd: ROOT },
);

if (result.error) fail(`7za başlatılamadı: ${result.error.message}`);
if (result.status !== 0) fail(`7za ${result.status} koduyla sonlandı.`);

const gb = (fs.statSync(ARCHIVE).size / 1024 ** 3).toFixed(2);
console.log(`\n[gpu-eklentisi] Hazır: ${ARCHIVE} (${gb} GB)`);
console.log('[gpu-eklentisi] Installer ile birlikte dağıtılır; kullanıcı uygulama içinden kurar.');
