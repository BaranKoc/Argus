# Argus — Kurulum ve Kullanım

[← README](../README.md)

## Kurulum

`Argus-Setup-<sürüm>.exe` dosyasını çalıştırın. Argus tek kullanıcılıdır ve açıldığında
doğrudan kayıt ekranına gelir; hesap, rol veya parola kurulumu yoktur.

Windows yeni veya imzasız bir uygulama için SmartScreen uyarısı gösterebilir. Yalnızca
projenin resmi GitHub Releases sayfasından indirdiğiniz dosyayı çalıştırın.

## İlk analiz

Varsayılan analiz sağlayıcısı yerel Ollama'dır. Ollama'nın çalıştığından ve Ayarlar →
Analiz modeli sekmesinde yazan modelin indirildiğinden emin olun. Aynı sekmeden OpenAI,
Anthropic, Gemini veya OpenAI uyumlu özel bir sunucu seçebilirsiniz.

Bulut sağlayıcısı seçildiğinde toplantı dökümü analiz amacıyla o sağlayıcıya gönderilir.
Ses kaydı gönderilmez.

## Toplantı kaydetme

1. Toplantı dilini seçin.
2. Grup toplantısı veya Online İkili Görüşme seçin.
3. **Kayıt Başlat** düğmesine basın ve mikrofon/ekran sesi izinlerini verin.
4. Gerektiğinde mola verin; bitince **Kaydı Bitir** düğmesine basın.
5. Transkripsiyon ve analiz tamamlanınca **Sonuçları Gör** ile kaydı açın.

Online İkili Görüşme seçeneğinde `Yerel` ve `Uzak` kaynakları iki tarafı zaten ayırdığı
için Pyannote o toplantıda çalıştırılmaz.

## Konuşmacı ayrımı

Pyannote konuşmacı ayrımı NVIDIA GPU ister. Installer'ın yanında verilen
`Argus-GPU-Destegi.7z` arşivini Ayarlar → Konuşmacı ayrımı sekmesindeki **GPU desteğini
kur** düğmesiyle seçin. CUDA Toolkit kurmanız gerekmez; gerekli runtime arşivdedir.

Özellik özellikle farklı mikrofonlardan gelen 3–4 kişilik online toplantılarda faydalıdır.
Aynı odada tek mikrofona konuşan kalabalık gruplar daha zor bir senaryodur.

## Arşiv ve dışa aktarma

Kayıtlar ekranında toplantı adını ve analiz bölümlerini düzenleyebilir, konuşmacıları
adlandırabilir, eski düzenlemeleri geri alabilir ve toplantıyı yeniden analiz edebilirsiniz.
PDF önizleme/yazdırma/paylaşma ve Markdown/PDF indirme seçenekleri bulunur.

## Yerel veri

Toplantılar ve ayarlar Windows'ta Electron'ın Argus `userData` dizininde — yani
`%APPDATA%\Argus` altında — saklanır. Geçici WAV toplantı tamamlanınca silinir ve arşivde
ses dosyası tutulmaz.

## Sorun giderme

- **Analiz başlamıyor:** Ayarlar → Analiz modeli sekmesinde sağlayıcı, model, sunucu ve
  gerekiyorsa API anahtarını kontrol edin.
- **Sistem sesi yok:** Windows ses kaynağını ve ekran yakalama iznini kontrol edin; Argus
  mikrofonla devam edebilir.
- **Konuşmacı ayrımı açılamıyor:** NVIDIA sürücüsünü güncelleyin ve GPU desteği arşivini
  Ayarlar'dan kurun.
- **GPU bulunamadı:** Toplantı konuşmacı etiketleri olmadan tamamlanır; döküm ve analiz korunur.
