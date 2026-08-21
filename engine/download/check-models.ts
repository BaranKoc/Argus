// Verify the cached Whisper and developer-provisioned Pyannote assets required by
// a fully offline desktop package. This command never downloads anything.

import fs from 'node:fs';
import path from 'node:path';
import { resolveDownloadPairs, whisperFileStatus } from '../bench/matrix.ts';
import { MODELS_DIR, PYANNOTE_MODEL_VERSION } from '../diarization-config.ts';

let hardMissing = 0;
for (const { model, dtype } of resolveDownloadPairs()) {
  const { required, missing } = whisperFileStatus(model, dtype);
  if (missing.length === 0) {
    console.log(`✓ ${model} @ ${dtype} (${required.length} dosya)`);
    continue;
  }
  hardMissing += missing.length;
  console.log(`✗ ENGINE_MODEL=${model} ENGINE_DTYPE=${dtype}`);
  for (const file of missing) console.log(`    Eksik: ${file}`);
  console.log(`    Çözüm: ENGINE_DOWNLOAD_MATRIX=${model}:${dtype} npm run download-models`);
}

const pyannoteRoot = path.join(MODELS_DIR, 'pyannote');
const python = path.join(pyannoteRoot, 'runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const modelConfig = path.join(pyannoteRoot, PYANNOTE_MODEL_VERSION, 'config.yaml');
if (fs.existsSync(python) && fs.existsSync(modelConfig)) {
  console.log(`✓ Pyannote Community-1 (${pyannoteRoot})`);
} else {
  hardMissing += 1;
  console.log('✗ Pyannote Community-1');
  if (!fs.existsSync(python)) console.log(`    Eksik çalışma zamanı: ${python}`);
  if (!fs.existsSync(modelConfig)) console.log(`    Eksik model: ${modelConfig}`);
  console.log('    Çözüm: npm run download-pyannote');
}

if (hardMissing > 0) {
  console.error(`\n${hardMissing} eksik model/çalışma zamanı öğesi var — yukarıdaki komutları çalıştırın.`);
  process.exit(1);
}
console.log('\nTüm gerekli çevrimdışı varlıklar mevcut.');
