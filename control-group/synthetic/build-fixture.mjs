// Sentetik analiz fixture'ı üretir: satır başına bir konuşma sırası olan düz metinden
// control-group transcribe JSON'u.
//
// [[LOOP:metin:n]] işaretçisi n kez tekrarlanan sıraya açılır — gerçek fixture'lardaki
// ASR döngülerinin karşılığı. Bunlar kusur değil testin parçası: bu fixture'ların işi
// analizörün bozuk girdiyle başa çıkışını sınamak.
//
// Uydurma bir `config` bloğu YAZILMAZ — bu dosyalar bir modelin çıktısı değil, elle
// yazılmış girdilerdir; model üretmiş gibi göstermek soy kaydını yalanlamak olurdu.

import fs from 'node:fs';
import path from 'node:path';

const [, , src, dest, base] = process.argv;
if (!src || !dest || !base) {
  console.error('kullanım: node build-fixture.mjs <kaynak.txt> <hedef.json> <base>');
  process.exit(1);
}

const turns = [];
for (const raw of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line) continue;
  const m = /^\[\[LOOP:(.+):(\d+)\]\]$/.exec(line);
  if (m) {
    for (let i = 0; i < Number(m[2]); i++) turns.push(m[1]);
  } else {
    turns.push(line);
  }
}

// Konuşma hızından türetilen makul zaman damgaları: ~14 karakter/saniye, en az 0.8 sn.
let t = 0;
const segments = turns.map((text) => {
  const dur = Math.max(0.8, Math.round((text.length / 14) * 100) / 100);
  const seg = { start: +t.toFixed(3), end: +(t + dur).toFixed(3), text: ` ${text}` };
  t += dur;
  return seg;
});

const json = {
  file: base,
  outputType: 'transcribe',
  recordingType: 'static',
  synthetic: {
    note: 'Elle yazılmış sentetik analiz fixture\'ı. Gerçek toplantı değildir; kişi, şirket ve '
      + 'ürün adları uydurmadır. Kasıtlı ASR bozulmaları (döngüler, yanlış duyumlar) içerir — '
      + 'analizörün bozuk girdiyle başa çıkışını sınamak için.',
    generatedFrom: src.split(/[\\/]/).pop(),
  },
  text: turns.join(' '),
  segments,
};

fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(json, null, 2));
console.log(`${base}: ${turns.length} sıra, ${json.text.length} karakter, ${(t / 60).toFixed(1)} dk`);
const SINGLE_PASS_LIMIT = 4096 * 3.5; // numCtx(8192) - RESPONSE_RESERVE(4096) tokens × charsPerToken
console.log(`  yol: ${json.text.length < SINGLE_PASS_LIMIT - 2000 ? 'tek geçiş' : 'map-reduce (çok parçalı)'}`);
