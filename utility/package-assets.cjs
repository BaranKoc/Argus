const fs = require('node:fs');
const path = require('node:path');

// The CUDA runtime is a BUILD input, not a packaged one: utility/build-gpu-addon.cjs turns
// it into the separate archive the app installs into itself. It is still required here,
// because a release without the add-on is a release where speaker separation can never be
// switched on. See electron-builder.config.cjs for why it cannot ride in the installer.
const CUDA_RUNTIME_DIR = 'build/pyannote-runtime-cuda';

// Both production Whisper models: turbo transcribes Turkish, medium is what a meeting
// marked "Yabancı dil" decodes with.
const ASSET_GROUPS = [
  {
    name: 'Whisper q8 modelleri (turbo + medium)',
    // Plain download-models fetches both production models; the ENGINE_DOWNLOAD_MATRIX
    // dance is only needed for bench-only variants.
    command: 'npm run download-models -w engine',
    files: [
      'models/onnx-community/whisper-large-v3-turbo/config.json',
      'models/onnx-community/whisper-large-v3-turbo/generation_config.json',
      'models/onnx-community/whisper-large-v3-turbo/preprocessor_config.json',
      'models/onnx-community/whisper-large-v3-turbo/tokenizer.json',
      'models/onnx-community/whisper-large-v3-turbo/tokenizer_config.json',
      'models/onnx-community/whisper-large-v3-turbo/onnx/encoder_model_quantized.onnx',
      'models/onnx-community/whisper-large-v3-turbo/onnx/decoder_model_merged_quantized.onnx',
      'models/onnx-community/whisper-medium-ONNX/onnx/encoder_model_quantized.onnx',
      'models/onnx-community/whisper-medium-ONNX/onnx/decoder_model_merged_quantized.onnx',
    ],
  },
  {
    name: 'Pyannote Community-1 modeli',
    command: 'npm run download-pyannote -w engine',
    files: [
      'models/pyannote/speaker-diarization-community-1/config.yaml',
      'models/pyannote/speaker-diarization-community-1/embedding/pytorch_model.bin',
      'models/pyannote/speaker-diarization-community-1/segmentation/pytorch_model.bin',
      'models/pyannote/speaker-diarization-community-1/plda/plda.npz',
      'models/pyannote/speaker-diarization-community-1/plda/xvec_transform.npz',
    ],
  },
  {
    name: 'taşınabilir CUDA Pyannote runtime (GPU eklentisinin kaynağı)',
    command: 'npm run build-pyannote-runtime -w engine',
    files: [`${CUDA_RUNTIME_DIR}/python.exe`],
  },
  {
    name: '7za.exe (GPU eklentisini açan çıkarıcı)',
    command: 'npm install',
    files: ['node_modules/7zip-bin/win/x64/7za.exe'],
  },
];

function missingPackageInputs(root) {
  return ASSET_GROUPS.map((group) => ({
    ...group,
    missing: group.files.filter((relative) => !fs.existsSync(path.join(root, relative))),
  })).filter((group) => group.missing.length > 0);
}

function findPyvenvFiles(runtimeRoot) {
  if (!fs.existsSync(runtimeRoot)) return [];
  return fs.readdirSync(runtimeRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase() === 'pyvenv.cfg')
    .map((entry) => path.join(entry.parentPath, entry.name));
}

// The runtime folder name says "cuda" but nothing enforced it, and a CPU tree renamed
// into place would ship an add-on whose whole point cannot run. torch/version.py carries
// the wheel's own answer, so this is a text read rather than a multi-second interpreter
// spawn — and it asks about the wheel, not the build machine, which may have no GPU.
function cudaWheelProblem(root) {
  const versionFile = path.join(root, CUDA_RUNTIME_DIR, 'Lib', 'site-packages', 'torch', 'version.py');
  if (!fs.existsSync(versionFile)) return null;
  const text = fs.readFileSync(versionFile, 'utf8');
  const match = /^cuda\s*(?::\s*[^=]+)?=\s*(.+)$/m.exec(text);
  if (!match) return 'torch/version.py içinde cuda satırı okunamadı.';
  return /^none$/i.test(match[1].trim()) ? 'Runtime CPU torch taşıyor; CUDA bekleniyordu.' : null;
}

function assertPackageInputs(root) {
  const missing = missingPackageInputs(root);
  const pyvenvFiles = findPyvenvFiles(path.join(root, CUDA_RUNTIME_DIR));
  const wheelProblem = cudaWheelProblem(root);
  if (missing.length === 0 && pyvenvFiles.length === 0 && !wheelProblem) return;

  const lines = ['[paket] Installer için zorunlu varlık ön kontrolü başarısız.'];
  for (const group of missing) {
    lines.push('', `${group.name} eksik:`, ...group.missing.map((file) => `  - ${file}`));
    lines.push(`Çözüm: ${group.command}`);
  }
  if (pyvenvFiles.length > 0) {
    lines.push('', 'Runtime taşınabilir değil; pyvenv.cfg bulundu:', ...pyvenvFiles.map((file) => `  - ${file}`));
    lines.push('Çözüm: npm run build-pyannote-runtime -w engine -- --force');
  }
  if (wheelProblem) {
    lines.push('', wheelProblem);
    lines.push('Çözüm: npm run build-pyannote-runtime -w engine -- --force');
  }
  throw new Error(lines.join('\n'));
}

// --- What the PACKAGED tree must look like -----------------------------------------
// Paths under dist/win-unpacked/resources. Kept next to the source-side groups so
// "which assets ship" has exactly one answer and the post-package verifier cannot drift
// from the pre-package gate.
//
// The Pyannote RUNTIME is deliberately absent: it arrives later, as the GPU add-on the
// app extracts into models/pyannote/runtime. Everything else it needs is here already.
const UNPACKED_REQUIRED = [
  'models/onnx-community/whisper-large-v3-turbo/onnx/encoder_model_quantized.onnx',
  'models/onnx-community/whisper-large-v3-turbo/onnx/decoder_model_merged_quantized.onnx',
  'models/onnx-community/whisper-medium-ONNX/onnx/encoder_model_quantized.onnx',
  'models/onnx-community/whisper-medium-ONNX/onnx/decoder_model_merged_quantized.onnx',
  'models/pyannote/speaker-diarization-community-1/config.yaml',
  'models/pyannote/speaker-diarization-community-1/embedding/pytorch_model.bin',
  'models/pyannote/speaker-diarization-community-1/segmentation/pytorch_model.bin',
  '7za.exe',
  'app.asar.unpacked/out/main/pyannote-worker.py',
];

// Asserted absent, not merely unused: an installer that quietly carried 4.6 GB of CUDA
// runtime is the exact failure that broke the NSIS build in the first place.
const UNPACKED_FORBIDDEN = ['models/pyannote/runtime/python.exe'];

module.exports = {
  ASSET_GROUPS,
  CUDA_RUNTIME_DIR,
  UNPACKED_FORBIDDEN,
  UNPACKED_REQUIRED,
  assertPackageInputs,
  missingPackageInputs,
};
