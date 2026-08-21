# Argus Geliştirici Rehberi

[← README](../README.md)

## Gereksinimler

- Windows 10/11
- Node.js 22+
- npm
- Yerel analiz için Ollama
- Konuşmacı ayrımı geliştirmesi için NVIDIA GPU

## Kurulum

```powershell
npm install
npm run download-models -w engine
npm run download-pyannote -w engine
npm run dev
```

Model dosyaları `models/`, gerçek test sesleri `test_media/` altındadır. İkisi de Git'e
eklenmez. Public geliştirme için yalnızca paylaşım izni olan veya sentetik medya kullanın.

## Uygulama yapısı

Argus açılışta doğrudan kayıt ekranına gelir. Kayıtlar ve Ayarlar aynı tek kullanıcı
kabuğundadır. Ayarlar içinde konuşmacı ayrımı ve analiz modeli/sunucusu sekmeleri bulunur.

| Alan | Kaynak |
|---|---|
| Electron main ve IPC | `src/main` |
| Preload sözleşmesi | `src/preload/index.ts` |
| Renderer ve kayıt | `src/renderer` |
| Transkripsiyon | `engine/transcribe` |
| Diarization | `engine/diarize` |
| Analiz ve LLM istemcileri | `engine/analyze` |
| Canlı pipeline | `engine/live` |
| Benchmark ve manuel test | `engine/bench`, `engine/test` |

## Kontroller

```powershell
npm test
npm test -w engine
npm run build
```

Engine davranışı değiştiğinde otomatik test yeterli değildir. Önce etkilenen senaryo
kullanıcıyla seçilir, sonra tek senaryo aracı çalıştırılır:

```powershell
npm run test-run -w engine
```

Araç sırasıyla dosya, işlem, çalışma biçimi ve gerekiyorsa diarization sorar. Çıktılar
`output/test_run/<timestamp>/` altında birikir; hiçbir test çıktısı otomatik silinmez.

## Control-group

`control-group/control-group.md`, her senaryonun seçilmiş referans JSON'unu açıkça adlandırır.
Araç klasördeki en yeni dosyayı tahmin etmez. `summary.md` WER, domain recall, duplicate,
overlap ve hallucination ölçümlerini taşır; metin mutlaka insan gözüyle de okunur.

Bir çıktıyı referans yapmak ayrı ve açık bir karardır:

```powershell
npm run promote -w engine -- <output-json-yolu>
```

Promote öncesinde kullanıcı onayı alınır. Git ile izlenen örnekler sentetik veya açıkça
paylaşılabilir içerikten üretilir; özel toplantı referansları yalnız yerel çalışma alanında kalır.

## Paketleme

```powershell
npm run build-pyannote-runtime -w engine
npm run dist
```

Üretilen ana dosyalar:

| Dosya | İçerik |
|---|---|
| `Argus-Setup-<sürüm>.exe` | Uygulama, Whisper modelleri ve Pyannote modeli |
| `Argus-GPU-Destegi.7z` | Ayrı CUDA/Python runtime |

GPU runtime installer içine konmaz; NSIS payload sınırı nedeniyle ayrı arşiv olarak üretilir.
`npm run dist` kaynak varlıklarını önceden ve paket ağacını üretimden sonra doğrular.

Uygulamanın dağıtım ikonları `resources/icon.png` ve `resources/icon.ico` olarak depoda hazırdır.
İkon tasarımı değiştirildiğinde iki dağıtım varlığı birlikte güncellenir ve installer üzerinde
yeniden doğrulanır.

## Release kontrol listesi

1. `npm run privacy-check` ile izlenen dosyalarda özel kayıt, ses/video veya Drive bağlantısı olmadığını doğrulayın.
2. `npm run privacy-check:history` ile reachable, reflog ve dangling object'ler dahil yerel Git
   object database'ini doğrulayın.
3. Şirket/kişi adı, gizli bağlantı ve anahtar taramasını insan gözüyle tamamlayın.
4. Root ve engine testlerini çalıştırın.
5. Etkilenen manuel control-group senaryolarını okuyun.
6. `npm run build` çalıştırın.
7. Üçüncü taraf model lisanslarını ve release bildirimlerini kontrol edin.
8. Temiz Windows ortamında kayıt → analiz → export akışını gözle doğrulayın.

## Git geçmişi gizlilik kapısı

`.claude/settings.json`, ana Claude Code agent'ı durmadan önce
`git-history-privacy-auditor` agent hook'unu otomatik çalıştırır. Hook çalışma ağacı ve tüm yerel
Git object database'i temiz değilse ana agent'ın işi bitirmesini engeller. Denetim bulguları
eşleşen özel değeri değil yalnızca object kimliğini, yolu ve veri türünü gösterir.

History rewrite kasıtlı olarak ayrı ve açık bir işlemdir:

```powershell
npm run privacy-rewrite
npm run privacy-rewrite -- --execute
```

İlk komut yalnızca preflight yapar. `--execute`, repo dışındaki geçici klasöre bağımsız mirror
yedeği alır; bütün branch/ref commit'lerini canonical proje kimliğiyle yeniden üretir, gizlilik
politikasına aykırı yolları çıkarır, özel commit trailer'larını temizler, reflog'u sona erdirir ve
eski object'leri prune eder. İçeriği güvenle otomatik dönüştürülemeyen bir blob bulursa işlem
başlamadan durur. Araç remote'a push yapmaz. Rewrite sonrası iki privacy kontrolünü ve test/build
akışını yeniden çalıştırın; force-push ayrı bir yayın kararıdır. Daha önce paylaşılmış bir
credential bulunduysa geçmiş temizlense bile rotate edilir.
