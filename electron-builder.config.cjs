const { assertPackageInputs } = require('./utility/package-assets.cjs');

// An incomplete installer looks valid until a meeting ends, when it is too late to repair
// the user's recording. Packaging therefore fails before electron-builder writes anything.
assertPackageInputs(__dirname);

// ONE installer. There was briefly a Full/Light split so a user without an NVIDIA card
// would not carry the 4.6 GB CUDA runtime — but that runtime cannot go in an installer at
// all: makensis.exe is 32-bit and cannot mmap the payload archive, which measured 2.8 GB
// against a ~2 GB ceiling. Trimming does not close that gap; the three largest DLLs are
// mandatory and total ~2 GB on their own. So the runtime ships as a separate archive the
// app installs into itself (utility/build-gpu-addon.cjs, src/main/gpu-addon.ts), and with
// it gone the two variants differed by a 33 MB model — not worth two artifacts.
//
// Keeping the runtime out of the installer also keeps the signing path open: the installer
// runs no external executable during setup.

// env.cacheDir is pinned to <install>/resources/models by src/main/index.ts, so every
// path below is relative to that root and must match the layout Transformers.js and
// SettingsStore expect. Only quantized weights ship; turbo's fp32 variants exist for
// bench runs alone and would add ~3 GB.
//
// TWO Whisper models: turbo transcribes Turkish, medium is what a meeting marked
// "Yabancı dil" decodes with.
const extraResources = [
  {
    from: 'models/onnx-community/whisper-large-v3-turbo',
    to: 'models/onnx-community/whisper-large-v3-turbo',
    filter: [
      '**/*',
      '!onnx/encoder_model.onnx',
      '!onnx/encoder_model.onnx_data',
      '!onnx/decoder_model_merged.onnx',
    ],
  },
  {
    // Published quantized-only, so there is nothing to filter out here.
    from: 'models/onnx-community/whisper-medium-ONNX',
    to: 'models/onnx-community/whisper-medium-ONNX',
    filter: ['**/*'],
  },
  {
    from: 'models/pyannote/speaker-diarization-community-1',
    to: 'models/pyannote/speaker-diarization-community-1',
    filter: ['**/*', '!.cache/**', '!diarization.gif'],
  },
  {
    // The extractor the app uses to install the GPU add-on into itself. ~2 MB, and it
    // means the user needs no 7-Zip installed to add GPU support.
    from: 'node_modules/7zip-bin/win/x64/7za.exe',
    to: '7za.exe',
  },
];

module.exports = {
  appId: 'dev.barankoc.argus',
  productName: 'Argus',
  executableName: 'Argus',
  copyright: '© Baran Koc',
  directories: { output: 'dist' },

  // Both native addons ship prebuilt N-API binaries, which are ABI-stable across the
  // Node and Electron versions we target. Rebuilding them from source would need the
  // MSVC toolchain on every build machine and gains nothing.
  npmRebuild: false,

  files: [
    'out/**/*',
    // ffmpeg is dead weight here: the app feeds the engine Float32 PCM from the
    // renderer and never calls transcribe(), so Rollup tree-shakes the ffmpeg decode
    // path out of out/main entirely. Only the engine CLI and bench still use it.
    '!node_modules/ffmpeg-static/**',
    // onnxruntime-node resolves its binary as bin/napi-v3/<platform>/<arch>; the other
    // platforms' copies are 141 MB that a Windows installer can never load.
    '!node_modules/onnxruntime-node/bin/napi-v3/{darwin,linux}/**',
  ],

  // asar is a virtual archive. Electron patches Node's fs to read through it, but the
  // OS loader (native .dll/.node) and a spawned Python have no such shim, so anything
  // opened outside Node's fs has to exist as a real file.
  asarUnpack: [
    'out/main/pyannote-worker.py',
    '**/*.node',
    'node_modules/onnxruntime-node/**',
  ],

  extraResources,

  win: {
    target: ['nsis'],
    artifactName: 'Argus-Setup-${version}.${ext}',
    // Named explicitly rather than left to the buildResources default: `build/` here is
    // the CUDA runtime's home, not an electron-builder asset folder.
    icon: 'resources/icon.ico',
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: 'Argus',
    // Differential packaging hashes the whole payload to produce update blockmaps.
    // At this size that is minutes of build time for an artifact nothing consumes.
    differentialPackage: false,
  },
};
