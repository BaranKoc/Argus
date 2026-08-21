import type { AnalysisDraft } from './sections.ts';
import { ANALYSIS_SECTIONS, serializeAnalysisMarkdown } from './sections.ts';

const SECTION_GUIDE = ANALYSIS_SECTIONS.map((section, index) => {
  const instructions: Record<string, string> = {
    mainRequest: 'Tek madde: doğrudan talep çapalarındaki en açık ana ihtiyaç; çapa yoksa açık gündem veya tekrarlanan hedefteki merkezi toplantı amacı.',
    contextAndTopics: 'Önemli arka plan, ana konular, görüşler, itirazlar ve neden-sonuç ilişkileri.',
    decisions: 'Yalnız açık kabul veya kesin kararla sonuçlanmış maddeler; beğeni ve değerlendirmeler karar değildir.',
    rejectedOrDeferred: 'Reddedilen seçenekler ile ertelenen konular; durumunu maddede açıkça belirt.',
    actionItems: 'Yalnız adı veya tartışmasız rolü belli bir kişiye atanmış somut işler; varsa tarih ve koşulla birlikte.',
    questionsAndAnswers: 'Yalnız anlamı açık esaslı soru-cevaplar; bozuk soruyu yorumlama, konuşmacı belli değilse rol atama.',
    risksAndBlockers: 'Yalnız açıkça sorun veya olumsuz etki olarak belirtilen riskler ve engeller.',
    nextSteps: 'Bir kişiye atanmamış fakat açıkça kabul edilmiş gelecek adımları; mevcut özellik ve kayıt durumunu değil.',
    detectedValues: 'Her madde "etiket: değer" biçiminde olsun (ör. "sipariş numarası: EK2451", "kalan miktar: 3200 metre", "servis günü: Salı", "durum: break even"). Etiket en çok üç kelime; değeri dökümde YAZDIĞI GİBİ kopyala, rakam-yazı çevrimi veya yuvarlama yapma. Tutar, oran, tarih, gün, süre, adet, metraj, sipariş/ürün kodu ve açıkça bir duruma bağlanmış nitel değerler alınır; genel isim, platform ve henüz yapılmamış iş değer değildir. Konuşmacı kendini düzeltirse yalnız son geçerli değeri yaz.',
  };
  return `${index + 1}. ${section.key} — ${section.title}: ${instructions[section.key]}`;
}).join('\n');

export const ANALYSIS_SYSTEM_PROMPT = `Sen deneyimli bir Türkçe toplantı analistisin. Dökümdeki
önemli bağlamı, gerekçeleri ve sonuçları kaybetmeden ayrıntılı fakat tekrarsız bir analiz üret.

Yanıt alanları:
${SECTION_GUIDE}

Tam döküm veya sana verilen parça notları tek bağlayıcı kaynaktır. Her madde açık ve anlaşılır bir
metin parçası tarafından doğrudan desteklenmelidir; metinde söylenmeyen teknik açıklamayı veya
beklenen faydayı tamamlama. Alanlar doldurulması gereken kota değildir;
dayanak yoksa boş dizi doğru sonuçtur. Özellikle "asıl istediğim",
"benim sorum", "en çok işime yarayacak", "ihtiyacımız" ve "amacımız" gibi doğrudan talepleri ana
istekten daha genel bir temanın altında kaybetme. "En çok işime yarayacak" veya "asıl istediğim"
ile açıklanan somut ihtiyaç, daha önceki genel soru ve bozuk ifadelerden önceliklidir. mainRequest,
talep çapası verildiyse yalnız o çapanın anlaşılır kısmından üretilir; başka gündem maddesi ana isteğe
eklenmez. Talep çapası yoksa açıkça söylenen gündem veya toplantı boyunca tekrarlanan merkezi ihtiyaçtan
mainRequest için tam bir toplantı amacı yaz; yalnız içerik taşımayan kayıtta boş bırak. Bir görüşü yalnız
döküm boyunca tutarlı kullanılan "Ad: söz" biçimindeki açık konuşmacı etiketi ya da cümlenin kendisi
söyleyeni tartışmasız gösteriyorsa kişiye veya role ata; aksi halde nötr anlat. Etiketsiz cümlenin başındaki
"tamam", "samam", ünlem, hitap veya tek başına büyük harfli sözcüğü kişi adı ya da konuşmacı etiketi sayma.
Dökümde geçmeyen müşteri temsilcisi, satıcı veya karşı taraf gibi roller üretme.

Karar, ret, erteleme, öneri ve ihtimali kipliklerine sadık kalarak ayır. "Güzel çıktı veriyor" bir
değerlendirmedir; kullanma kararı değildir. "Kaldırabilirim" bir imkan beyanıdır; kaldırma kararı
veya ret değildir. Buna karşılık "gerek yok" açıkça reddedilen seçeneği gösterir. "Yapabiliriz",
"kaldırabilirim", "olabilir" ve "düşünebiliriz" kesin karar değildir. Aksiyon Maddeleri yalnız açıkça
adı veya rolü belli birine atanmış görevleri, Sonraki Adımlar ise açıkça kabul edilmiş fakat atanmamış genel yönü taşır; "konuşmacı" veya
"katılımcı" sorumlu kişi değildir. Aynı maddeyi iki alanda
tekrarlama. Kimliği belirsiz birinin "gönderirim", "geri çekerim" gibi kabul edilmiş gelecek zaman
taahhüdünü kişi uydurmadan Sonraki Adımlar'a yaz; bunu tamamlanmış karar, ret veya erteleme sayma.
Konuşulmuş bir değeri onaylanmış gibi sunma.

ASR kaynaklı bir ifade Türkçe olarak ayrıştırılamıyor veya bağlama oturmuyorsa onu ana konu yapma;
kişi, kurum, süreç ya da terim tahminiyle tamamlama. Sırf yabancı olduğu için anlamlı bir alan
terimini bozuk sayma. Geçici
kayıt bildirimlerini, anlamsız tekrarları ve içerik taşımayan sohbeti alma. Her alan string dizisidir;
bulgu yoksa boş dizi döndür. Maddelerde ölçülü **kalın** vurgu kullanılabilir, ham HTML kullanma.`;

function anchorBlock(requestAnchors: string[], entityAnchors: string[]): string {
  const requestBlock = requestAnchors.length > 0
    ? requestAnchors.map((item) => `- ${item}`).join('\n')
    : '- Doğrudan talep kalıbı yok. Toplantı içerikliyse mainRequest alanını açık gündemdeki merkezi amaçtan üret.';
  // Eski boş-çapa metni ("bu durumda detectedValues boş olmalıdır") modele bölümü boş
  // bırakmayı emrediyordu; sayısal değeri olmayan ama nitel değeri olan toplantılarda
  // (S4-C: "neredeyse break even'dayız") bölümün boş çıkmasının doğrudan sebebi buydu.
  const entityBlock = entityAnchors.length > 0
    ? entityAnchors.map((item) => `- ${item}`).join('\n')
    : '- Otomatik çapa bulunamadı; bu bir "değer yok" bildirimi değildir. Değerleri doğrudan dökümden çıkar.';
  return `Doğrudan talep çapaları (alıntılar yorum değil; yalnız anlaşılır kısmı kullan):\n${requestBlock}\n\nSayısal değer çapaları (dökümden birebir çıkarıldı; detectedValues BUNLARLA SINIRLI DEĞİLDİR — bunları "etiket: değer" biçiminde etiketle ve dökümde geçen diğer değerleri de ekle):\n${entityBlock}\n\n`;
}

function speakerLabelBlock(transcript: string): string {
  const hasStructuredLabels = transcript.split(/\r?\n/).some((line) => (
    /^(?:\[[^\]]+\]|(?:speaker|konuşmacı)[ _-]?\d+|[\p{L}][\p{L} .'-]{0,40}):\s+/iu.test(line.trim())
  ));
  return hasStructuredLabels
    ? 'Döküm yapısal konuşmacı etiketleri içeriyor; yalnız bu etiketleri kişi atamasında kullan.\n\n'
    : 'Dökümde yapısal konuşmacı etiketi yok. Cümle başındaki sözcükler kişi adı değildir; özellikle "samam" veya "tamam" konuşmacı olamaz. Birinci tekil gelecek taahhüdünü kişi uydurmadan Sonraki Adımlar alanına yaz ve parantez içinde konuşmacı ataması üretme.\n\n';
}

export function buildSinglePrompt(
  transcript: string,
  requestAnchors: string[],
  entityAnchors: string[],
): string {
  return `${anchorBlock(requestAnchors, entityAnchors)}${speakerLabelBlock(transcript)}=== TAM TOPLANTI DÖKÜMÜ ===\n${transcript.trim()}`;
}

export function buildMapPrompt(chunk: string, index: number, total: number): string {
  return `Bu, uzun bir toplantı dökümünün ${index + 1}/${total}. parçasıdır. Yalnız bu parçada açıkça
bulunan bilgileri ilgili alanlara çıkar. Diğer parçalarda ne olabileceğini varsayma. Nihai analiz daha
sonra birleştirileceği için tekrar eden ifadeleri çoğaltma ve her ilgili alanda en fazla üç özlü ama
bağlamlı madde kullan. Bu üç madde sınırı yalnız detectedValues için geçerli değildir: bu parçada
geçen her değeri "etiket: değer" biçiminde ayrı madde olarak yaz.\n\n${speakerLabelBlock(chunk)}=== DÖKÜM PARÇASI ${index + 1}/${total} ===\n${chunk.trim()}`;
}

export function buildReducePrompt(
  drafts: AnalysisDraft[],
  requestAnchors: string[],
  entityAnchors: string[],
): string {
  const partials = drafts
    .map((draft, index) => `--- Kısmi analiz ${index + 1} ---\n${serializeAnalysisMarkdown(draft)}`)
    .join('\n\n');
  return `Aşağıdaki kısmi analizleri tek ve tutarlı bir nihai analizde birleştir. Aynı bulguyu tekrar
etme. Çelişen veya zaman içinde değişen ifadelerde yalnız kısmi analizlerin açıkça desteklediği son
geçerli durumu yaz; öneriyi karara dönüştürme.\n\n${anchorBlock(requestAnchors, entityAnchors)}${partials}`;
}
