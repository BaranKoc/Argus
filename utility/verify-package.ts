// Post-package check: node utility/verify-package.ts
//
// The pre-package gate (utility/package-assets.cjs) asks "do the source assets exist";
// this asks "did the right ones land in dist/, and would the shipped app agree". Both
// read their expectations from the same module so they cannot drift.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SettingsStore } from '../src/main/settings.ts';

const require = createRequire(import.meta.url);
const { UNPACKED_REQUIRED, UNPACKED_FORBIDDEN } = require('./package-assets.cjs') as {
  UNPACKED_REQUIRED: string[];
  UNPACKED_FORBIDDEN: string[];
};

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RESOURCES = path.join(DIST, 'win-unpacked', 'resources');
const PYANNOTE = path.join(RESOURCES, 'models', 'pyannote');

// The GPU add-on is a release artifact in its own right: without it the installer can
// never gain speaker separation, so a release that forgot it is incomplete.
const ADDON = path.join(DIST, 'Argus-GPU-Destegi.7z');
const ADDON_MIN_BYTES = 1024 ** 3;

function fail(message: string): never {
  throw new Error(`[paket-doğrulama] ${message}`);
}

if (!fs.existsSync(RESOURCES)) fail(`Paket bulunamadı: ${RESOURCES}\nÖnce: npm run dist`);

for (const relative of UNPACKED_REQUIRED) {
  if (!fs.existsSync(path.join(RESOURCES, relative))) fail(`Eksik unpacked içerik: ${relative}`);
}
for (const relative of UNPACKED_FORBIDDEN) {
  if (fs.existsSync(path.join(RESOURCES, relative))) {
    fail(`Pakette bulunmaması gereken içerik var: ${relative}`);
  }
}

if (!fs.existsSync(ADDON)) {
  fail(`GPU eklentisi üretilmemiş: ${ADDON}\nÖnce: node utility/build-gpu-addon.cjs`);
}
const addonBytes = fs.statSync(ADDON).size;
if (addonBytes < ADDON_MIN_BYTES) {
  fail(`GPU eklentisi beklenmedik biçimde küçük (${(addonBytes / 1024 ** 3).toFixed(2)} GB); arşiv eksik olabilir.`);
}

// The real question is not "do the files exist" but "would the shipped app agree". Here
// not-ready is the CORRECT outcome: the runtime arrives with the add-on, after install,
// so a fresh package reporting ready would mean the runtime leaked into the installer.
const settings = new SettingsStore(
  path.join(os.tmpdir(), `argus-package-verify-${process.pid}`),
  PYANNOTE,
);
const status = settings.status();
if (status.ready) fail('Paket Pyannote runtime taşıyor; o GPU eklentisiyle gelmeli.');
if (status.reason !== 'no-runtime') fail(`Beklenen durum no-runtime, gelen: ${status.reason}`);

const setups = fs.readdirSync(DIST).filter((name) => /^Argus-Setup-.*\.exe$/i.test(name));
if (setups.length !== 1) fail(`Tek Setup .exe bekleniyordu, ${setups.length} bulundu: ${setups.join(', ')}`);

console.log(`[paket-doğrulama] Başarılı: ${setups[0]}`);
console.log(`[paket-doğrulama] GPU eklentisi: Argus-GPU-Destegi.7z (${(addonBytes / 1024 ** 3).toFixed(2)} GB)`);
console.log('[paket-doğrulama] Whisper q8 (turbo+medium), Pyannote modeli, 7za ve worker mevcut; runtime doğru biçimde pakette değil.');
