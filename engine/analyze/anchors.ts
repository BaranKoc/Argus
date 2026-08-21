const NUMBER_WORD = '(?:sıfır|bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on|yirmi|otuz|kırk|elli|altmış|yetmiş|seksen|doksan|yüz|bin|milyon)';
const MONTH = '(?:ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)';
// Uzun biçim önce: "cuma" alternatifi "cumartesi"den önce gelirse cumartesi hiç eşleşmez
// (gövde tutar, ek tutmaz, sınır düşer).
const WEEKDAY = '(?:pazartesi|cumartesi|çarşamba|perşembe|pazar|salı|cuma)';
const UNIT = '(?:milyar|milyon|metrekare|metre|kilogram|kilo|vardiya|dakika|çalışan|hafta|palet|kalem|adet|puan|saat|hane|koli|kişi|ton|bin|gün|yıl|kg|ay)';
// Türkçe eki gövdeye yapışık gelir; ek listesi uzundan kısaya sıralı ve ardından harf
// gelmemeli — "400 çalışanı" tutar, "3 ayrı" tutmaz.
const SUFFIX = '(?:(?:ından|inden|undan|ünden|ında|inde|unda|ünde|lerin|ların|ndan|nden|lere|lara|leri|ları|den|dan|ler|lar|lik|lık|luk|lük|nin|nın|nun|nün|nda|nde|si|sı|su|sü|li|lı|lu|lü|ne|na|ye|ya|de|da|e|a|i|ı|u|ü)(?!\\p{L}))?';
// \b Türkçe harflerde çalışmaz (JS'te \w ASCII tabanlı), bu yüzden sınır iki yönlü
// olumsuz bakışla kurulur — yoksa "çarşamba" ve "ÇĞ1234" hiç eşleşmez.
const OPEN = '(?<![\\p{L}\\p{N}])';
const CLOSE = '(?![\\p{L}\\p{N}])';

const ENTITY_PATTERNS = [
  /%\s*\d+(?:[.,]\d+)?/giu,
  new RegExp(`yüzde\\s+(?:\\d+(?:[.,]\\d+)?|${NUMBER_WORD}(?:\\s+${NUMBER_WORD}){0,4})`, 'giu'),
  /\b\d+(?:[.,]\d+)?\s+(?:bin|milyon)\s+(?:TL|₺|EUR|€|USD|\$|euro|dolar|lira)\b/giu,
  /(?:\d{1,3}(?:[.\s]\d{3})*|\d+)(?:,\d+)?\s*(?:TL|₺|EUR|€|USD|\$|euro|dolar|lira)\b/giu,
  new RegExp(`${NUMBER_WORD}(?:\\s+${NUMBER_WORD}){0,5}\\s+(?:TL|EUR|USD|euro|dolar|lira)\\b`, 'giu'),
  new RegExp(`\\b\\d+(?:[.,]\\d+)?\\s+${UNIT}${SUFFIX}${CLOSE}`, 'giu'),
  // Sipariş/ürün kodu: harf ve rakam bitişik, en az üç rakam — "ERP"/"SKU" rakamsız,
  // "S8" üç rakam şartını taşımıyor, "EUR 1500" boşluklu olduğu için dışarıda kalır.
  new RegExp(`${OPEN}[A-ZÇĞIİÖŞÜ]{2,5}-?\\d{3,8}${CLOSE}`, 'gu'),
  /\b\d{4}-\d{2}-\d{2}\b/gu,
  // Yalnız TAM tarih. Yılsız "\d{1,2}[./-]\d{1,2}" biçimi ondalık sayıları tarih sanıyordu
  // ("3.2 puanlık bir fire sıçraması" → hayalet "3.2").
  /\b(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-]\d{2,4}\b/gu,
  new RegExp(`\\b\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?\\b`, 'giu'),
  new RegExp(`(?:${OPEN}(?:bu|gelecek|önümüzdeki|haftaya|geçen|ertesi)\\s+)?${OPEN}${WEEKDAY}${SUFFIX}(?:\\s+günü${SUFFIX})?${CLOSE}`, 'giu'),
];

const REQUEST_MARKERS = [
  'asıl istediğim',
  'benim sorum',
  'en çok işime yarayacak',
  'ihtiyacımız',
  'ihtiyacım',
  'amacımız',
  'amacım',
];

const STRONG_REQUEST_MARKERS = [
  'asıl istediğim',
  'en çok işime yarayacak',
  'ihtiyacımız',
  'ihtiyacım',
  'amacımız',
  'amacım',
];

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

export function extractEntityAnchors(transcript: string): string[] {
  const matches: Array<{ index: number; end: number; value: string }> = [];
  for (const pattern of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of transcript.matchAll(pattern)) {
      const index = match.index ?? 0;
      matches.push({ index, end: index + match[0].length, value: match[0] });
    }
  }
  matches.sort((a, b) => a.index - b.index || b.value.length - a.value.length);
  const nonOverlapping = matches.filter((match, index) => !matches.slice(0, index).some((earlier) => (
    earlier.index <= match.index && earlier.end >= match.end
  )));
  return uniqueInOrder(nonOverlapping.map((match) => match.value)).slice(0, 100);
}

export function extractRequestAnchors(transcript: string): string[] {
  const sentences = transcript
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const anchors: string[] = [];

  const hasStrongMarker = sentences.some((sentence) => {
    const normalized = sentence.toLocaleLowerCase('tr-TR');
    return STRONG_REQUEST_MARKERS.some((marker) => normalized.includes(marker));
  });

  for (let index = 0; index < sentences.length; index += 1) {
    const normalized = sentences[index].toLocaleLowerCase('tr-TR');
    const markers = hasStrongMarker ? STRONG_REQUEST_MARKERS : REQUEST_MARKERS;
    if (!markers.some((marker) => normalized.includes(marker))) continue;
    anchors.push(sentences.slice(Math.max(0, index - 1), Math.min(sentences.length, index + 9)).join(' '));
  }

  return uniqueInOrder(anchors).slice(0, 12);
}
