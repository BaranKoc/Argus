// Commands below are for running FROM THIS engine/ folder. From the repo root instead,
//
//   # default — medium q8 + diarization (~0.94 GB)
//   npm run download-models
//
//   # full benchmark matrix — adds turbo q8/split/fp32 (~4.2 GB)
//   $env:ENGINE_DOWNLOAD_MATRIX="bench"; npm run download-models; Remove-Item Env:ENGINE_DOWNLOAD_MATRIX
//
//   # one turbo variant only (q8 ~1 GB · fp32 ~3 GB)
//   $env:ENGINE_DOWNLOAD_MATRIX="onnx-community/whisper-large-v3-turbo:q8"; npm run download-models; Remove-Item Env:ENGINE_DOWNLOAD_MATRIX
//
// `npm run check-models` shows what a config still needs before you download.

process.env.ENGINE_ALLOW_DOWNLOAD = '1';

const fs = await import('node:fs');
const path = await import('node:path');
const { pipeline } = await import('@huggingface/transformers');
const { getConfig, parseDtype, MODELS_DIR } = await import('../models.ts');
const { resolveDownloadPairs, whisperFileStatus } = await import('../bench/matrix.ts');
const { MB, downloadWithResume } = await import('./fetch-file.ts');

// Which (model, dtype) pairs to cache — default is the configured model+dtype;
// ENGINE_DOWNLOAD_MATRIX=bench (or an explicit list) widens it. Transformers.js
// fetches ONLY the requested dtype's weights, so the pair (not just the model) matters.
const pairs = resolveDownloadPairs();
console.log(`Starting pre-download into ${MODELS_DIR} ...`);
console.log(`Whisper hedefleri: ${pairs.map((p) => `${p.model}@${p.dtype}`).join(', ')}`);

// A .onnx smaller than this is a stub whose weights live in a `<file>_data` sidecar
// (turbo's fp32 encoder). Mirrors EXTERNAL_DATA_THRESHOLD in bench/matrix.ts.
const EXTERNAL_DATA_THRESHOLD = MB;

// Fetch one Whisper repo file straight to the cache path Transformers.js expects
// (models/<id>/onnx/<file>), with resume + retry. `whisperFileStatus` hands us the
// absolute destination; the repo path is always onnx/<basename>.
async function downloadWhisperFile(modelId: string, dest: string): Promise<void> {
  const basename = path.basename(dest);
  const url = `https://huggingface.co/${modelId}/resolve/main/onnx/${basename}`;
  await downloadWithResume(url, dest, basename);
}

const { device } = getConfig();
for (const { model, dtype } of pairs) {
  console.log(`\n--- Whisper: ${model} @ ${dtype} ---`);
  // Idempotent: skip when the exact files this pair needs are already on disk
  // (never re-download over the slow office connection).
  const status = whisperFileStatus(model, dtype);
  if (status.missing.length === 0) {
    console.log('Zaten indirili, atlanıyor.');
    continue;
  }
  try {
    // Pull the big ONNX weights ourselves with resume + retry. The slow office line
    // drops mid-transfer and Transformers.js has no resume (it restarts from 0 each
    // time and its async fetch abort can crash the whole process). We fetch straight
    // to the cache paths, then call pipeline() only to grab the small config/tokenizer
    // files and validate that the model actually loads.
    for (const filePath of status.missing) {
      await downloadWhisperFile(model, filePath);
      // A stub .onnx (<1 MB) keeps its weights in a `<file>_data` sidecar — fetch it too.
      if (filePath.endsWith('.onnx') && fs.statSync(filePath).size < EXTERNAL_DATA_THRESHOLD) {
        const dataFile = `${filePath}_data`;
        if (!fs.existsSync(dataFile)) await downloadWhisperFile(model, dataFile);
      }
    }
    console.log('  ONNX ağırlıkları hazır — config/tokenizer indiriliyor ve model doğrulanıyor…');
    await pipeline('automatic-speech-recognition', model, { device, dtype: parseDtype(dtype) });
    console.log(`Successfully cached: ${model} @ ${dtype}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`Error downloading ${model} @ ${dtype}: ${message}`);
  }
}

// Report total disk used by the models/ cache so the office disk budget is visible.
function dirSize(dir: string): number {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

const GB = 1024 * 1024 * 1024;
console.log(`\nToplam models/ disk kullanımı: ${(dirSize(MODELS_DIR) / GB).toFixed(2)} GB`);
console.log('\nAll downloads complete.');
