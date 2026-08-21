<div align="center">

<h1>Argus</h1>

<h3><em>Kararları Görür</em></h3>

<p>
  <b>Argus</b>, Windows üzerinde mikrofon ve sistem sesini birlikte yakalayan; konuşmayı yerel<br>
  olarak yazıya döken ve toplantıyı kararlar, aksiyonlar, riskler, öneriler, sorular ve<br>
  önemli değerler halinde düzenleyen <b>local-first</b> bir masaüstü toplantı asistanıdır.
</p>

<p>
  <img alt="Platform: Windows" src="https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square&logo=windows&logoColor=white">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Whisper / ONNX" src="https://img.shields.io/badge/Whisper-ONNX%20Runtime-1f6feb?style=flat-square">
  <img alt="Lisans: MIT" src="https://img.shields.io/badge/Lisans-MIT-2ea44f?style=flat-square">
</p>

<p>
  <a href="docs/kurulum.md"><b>Kurulum ve kullanım</b></a>
  &nbsp;·&nbsp;
  <a href="docs/architecture.md"><b>Mimari</b></a>
  &nbsp;·&nbsp;
  <a href="docs/developer-guide.md"><b>Geliştirici rehberi</b></a>
  &nbsp;·&nbsp;
  <a href="docs/roadmap.md"><b>Yol haritası</b></a>
</p>

</div>

---

## Neden farklı?

- Toplantıya bot katmaz; mikrofon ve bilgisayar sesini doğrudan masaüstünde yakalar.
- Whisper/ONNX transkripsiyonu cihaz üzerinde çalışır.
- Her konuşma turunun odadan mı (`Yerel`) karşı taraftan mı (`Uzak`) geldiğini işaretler.
- İsteğe bağlı Pyannote konuşmacı ayrımı tamamen yerel çalışır.
- Analiz Ollama ile yerel veya OpenAI, Anthropic, Gemini ve OpenAI uyumlu özel bir
  sunucuyla yapılabilir.
- Toplantılar düzenlenebilir, yeniden analiz edilebilir ve PDF/Markdown olarak aktarılabilir.
- Control-group, WER, domain recall ve insan okumasını birleştiren kalite sistemi içerir.

## Ürün durumu

| Yetenek | Durum |
|---|---|
| Mikrofon + sistem sesiyle canlı kayıt | Hazır |
| Türkçe yerel transkripsiyon | Hazır |
| Yabancı dil konuşmasını Türkçe döküme çevirme | Beta |
| Yerel / Uzak kaynak işaretleme | Hazır |
| Pyannote konuşmacı ayrımı | Hazır; NVIDIA GPU gerekir |
| Yapılandırılmış toplantı analizi | Hazır |
| Arşiv, düzenleme ve yeniden analiz | Hazır |
| PDF ve Markdown dışa aktarma | Hazır |
| Windows installer | Yerel olarak üretilebilir |

## Teknoloji

- Electron, TypeScript, Vite
- Transformers.js, ONNX Runtime, Whisper
- Pyannote ve ayrı Python worker
- Ollama, OpenAI, Anthropic ve Gemini sağlayıcı katmanı
- Tipli preload/IPC sınırı ve yerel dosya depolama
- Node test runner ile sentetik ve yerel senaryolara dayalı regresyon araçları

## Gizlilik

Ses, transkripsiyon ve toplantı arşivi varsayılan olarak bilgisayarda kalır. Geçici WAV
toplantı tamamlanınca silinir; arşivde yalnızca döküm ve analiz tutulur. Ollama seçildiğinde
analiz de yereldir. Bulut sağlayıcısı seçilirse döküm, analiz amacıyla seçilen sağlayıcıya
gönderilir; bu fark Ayarlar ekranında açıkça gösterilir.

## Geliştirme

Gereksinimler: Windows, Node.js 22+ ve transkripsiyon modelleri.

```powershell
npm install
npm run dev
```

```powershell
npm test
npm test -w engine
npm run build
```

Model hazırlama, GPU desteği, paketleme ve control-group akışı için
[geliştirici rehberine](docs/developer-guide.md) bakın.

## Belgeler

- [Kurulum ve kullanım](docs/kurulum.md)
- [Mimari](docs/architecture.md)
- [Geliştirici rehberi](docs/developer-guide.md)
- [Yol haritası](docs/roadmap.md)
- [AI/agent geliştirme protokolü](docs/ai-agent-development-protocol.md)
- [Model seçimi ve performans](docs/model-selection.md)
- [Çok dilli transkripsiyon](docs/multilingual-transcription.md)
- [Konuşmacı ayrımı performansı](docs/diarization-performance.md)

## Lisans

Kaynak kod [MIT Lisansı](LICENSE) ile yayımlanır. İndirilen Whisper, Pyannote ve diğer
üçüncü taraf model/runtime dosyaları kendi lisans koşullarına tabidir ve Git deposuna dahil
edilmez.
