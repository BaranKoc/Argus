// "Tespit Edilen Değerler" bölümünün kaynağı: modelin ürettiği "etiket: değer" maddeleri,
// dökümle kanıtlananlar süzüldükten sonra; regex çapaları ise liste değil, geri-çağırma
// tabanıdır — modelin kaçırdığı çapa sona etiketsiz eklenir.
//
// WHY: etiketli bir model değeri ancak dökümdeki sözcük dizisiyle kanıtlanabiliyorsa güvenlidir;
// regex çapalarını tek kaynak yapmak ise metraj, ürün kodu ve niteliksel değerleri kaybettirir.
// analyzeTranscript tam dökümü taşıdığı için kapı quote alanına ihtiyaç duymadan doğrudan
// "değer ⊂ döküm" ilişkisini doğrular.

import { normalizeForMatch, tokens } from './normalize.ts';

interface LabeledValue {
  label: string | null;
  valueTokens: string[];
  itemTokens: string[];
  text: string;
}

// Düzyazı bir değer değildir. Bu sınırlar modelin bölüme cümle yazmasını eler; sayılar
// gerçek senaryolardan: en uzun meşru değer "14 Ağustos Perşembe" (3), en uzun meşru
// etiket "ek talep edilen miktar" (4).
const MAX_VALUE_TOKENS = 6;
const MAX_LABEL_TOKENS = 5;
const MAX_UNLABELED_VALUE_TOKENS = 3;
const MAX_DETECTED_VALUES = 24;

// Türkçe eki kabul ederken sayı ortası eşleşmesini kapatan tek kural: ekin ardından gelen
// kalan HARFLE başlamalı. "metre"→"metrelik" geçer, "400"→"4000" ve "%12"→"%12,5" geçmez.
function isSuffixOf(long: string, short: string): boolean {
  return long.length > short.length
    && long.startsWith(short)
    && /^\p{L}/u.test(long.slice(short.length));
}

// Çift yönlü: eki hangi tarafın taşıdığı önceden bilinmiyor — çapa "1200 metresi" ile
// madde "1200 metre" aynı değeri anlatır.
function tokensMatch(a: string, b: string): boolean {
  return a === b || isSuffixOf(a, b) || isSuffixOf(b, a);
}

// Kapı: değer belirteçleri dökümde BİTİŞİK bir dizi olarak geçmeli. Yalnız son belirteç ek
// alabilir ve yalnız ileri yönde — dökümdekinden uzun bir model değeri alıntı değil, eklemedir.
function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      const hay = haystack[start + offset];
      const want = needle[offset];
      if (hay === want) continue;
      if (offset === needle.length - 1 && isSuffixOf(hay, want)) continue;
      continue outer;
    }
    return true;
  }
  return false;
}

// Kapsama sırasız ve maddenin BÜTÜNÜNE karşı bakılır (etiket dahil), çünkü birim çoğu zaman
// etikette durur: çapa "400 çalışanı" ile madde "çalışan sayısı: 400" aynı bilgidir.
function anchorCovered(item: LabeledValue, anchorTokens: string[]): boolean {
  return anchorTokens.length > 0
    && anchorTokens.every((anchor) => item.itemTokens.some((token) => tokensMatch(token, anchor)));
}

function parseItem(raw: string): LabeledValue | null {
  const text = raw.trim();
  if (!text) return null;

  const colon = text.indexOf(':');
  const label = colon > 0 ? text.slice(0, colon).trim() : null;
  const value = colon > 0 ? text.slice(colon + 1).trim() : text;
  if (!value) return null;

  const valueTokens = tokens(normalizeForMatch(value));
  if (valueTokens.length === 0 || valueTokens.length > MAX_VALUE_TOKENS) return null;
  if (label && tokens(normalizeForMatch(label)).length > MAX_LABEL_TOKENS) return null;
  // "pazartesi: Pazartesi" bir etiketleme değil, çapanın kendisine sarılmış hali. Maddeyi
  // düşürmek onu kaybetmez: kapsanmamış çapa olarak tabandan sade biçimde geri gelir.
  if (label && normalizeForMatch(label) === normalizeForMatch(value)) return null;
  // Etiketsiz uzun madde düzyazıdır; etiketlide değer yarısı zaten ayrıca sınırlı.
  if (!label && valueTokens.length > MAX_UNLABELED_VALUE_TOKENS) return null;

  return { label, valueTokens, itemTokens: tokens(normalizeForMatch(text)), text };
}

// Konuşmacı kendini düzelttiğinde (S2-C: "%7 civarı… yok dur, %9'du") model aynı etiketi
// iki kez yazabilir. Silinen resolution/facts/ semantiği: aynı etiket → son değer geçerli.
// Sıra korunur ki bölüm döküm akışını izlesin.
function lastWinsByNormalizedLabel(items: LabeledValue[]): LabeledValue[] {
  const winner = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.label) winner.set(normalizeForMatch(item.label), index);
  });
  return items.filter((item, index) => (
    !item.label || winner.get(normalizeForMatch(item.label)) === index
  ));
}

export function mergeDetectedValues(
  modelItems: string[],
  entityAnchors: string[],
  transcript: string,
): string[] {
  const transcriptTokens = tokens(normalizeForMatch(transcript));

  const grounded: LabeledValue[] = [];
  for (const raw of modelItems) {
    const parsed = parseItem(raw);
    if (parsed && containsTokenRun(transcriptTokens, parsed.valueTokens)) grounded.push(parsed);
  }

  const merged = lastWinsByNormalizedLabel(grounded)
    .map((item) => item.text)
    .slice(0, MAX_DETECTED_VALUES);

  for (const anchor of entityAnchors) {
    if (merged.length >= MAX_DETECTED_VALUES) break;
    const anchorTokens = tokens(normalizeForMatch(anchor));
    // Kapsama `grounded` üzerinden bakılır, süzülmüş listeden DEĞİL: aksi halde son-geçerli
    // dedup'ın attığı eski değer (S2-C'de %7) "kapsanmamış çapa" sayılıp geri eklenir ve
    // düzeltme mekanizması düzeltmeyi geri getiren mekanizmaya dönüşür.
    if (grounded.some((item) => anchorCovered(item, anchorTokens))) continue;
    merged.push(anchor);
  }

  return merged;
}
