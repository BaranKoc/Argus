// Kanıt kapısı ve çapa kapsaması için ortak normalizasyon: ASR ile modelin meşru olarak
// farklı yazdığını yut, bir değeri diğerinden ayıran şeyi koru.

// Kesme işareti boşluğa çevrilmez, SİLİNİR — Türkçe eki gövdeye yapıştırmak için:
// "%9'du" → "%9du", "break even'dayız" → "break evendayız". detected-values.ts'teki
// belirteç eşlemesi tam da bu yapışık biçimi bekliyor.
const APOSTROPHE = /['‘’`´ʼ]/gu;

export function normalizeForMatch(text: string): string {
  // tr-TR şart: varsayılan toLowerCase, I/ı ve İ/i çiftini bozar ve eşleşmeyi kaydırır.
  let value = text.toLocaleLowerCase('tr-TR').replace(APOSTROPHE, '');

  value = value.replace(/yüzde\s+(?=\d)/gu, '%').replace(/%\s+(?=\d)/gu, '%');

  // Binlik ayracı: 12.500 → 12500. Zincirleme gruplarda (1.234.567) tek geçiş yetmez,
  // çünkü global replace eşleşmeden sonrasını atlar — sabitlenene kadar tekrarlanır.
  let previous: string;
  do {
    previous = value;
    value = value.replace(/(\d)[.\s](\d{3})(?!\d)/gu, '$1$2');
  } while (value !== previous);

  // Geriye kalan rakam-arası nokta ondalıktır: 7.2 ile 7,2 tek biçime iner.
  value = value.replace(/(\d)\.(\d)/gu, '$1,$2');

  // Virgül, YALNIZ iki rakam arasında kaldığında korunur; yoksa "%12,5" ile "%12"
  // ayırt edilemez hale gelir ve kapı yanlış kabul eder.
  value = value.replace(/[^\p{L}\p{N}%,]+/gu, ' ');
  value = value.replace(/,(?!\p{N})/gu, ' ');
  value = value.replace(/(?<!\p{N}),/gu, ' ');

  return value.replace(/\s+/gu, ' ').trim();
}

export function tokens(normalized: string): string[] {
  return normalized ? normalized.split(' ') : [];
}
