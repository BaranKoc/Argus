# Çok Dilli Konuşmayı Türkçe Döküme Çevirme

[← README'ye dön](../README.md)

Argus kayıt ekranındaki **Türkçe / Yabancı dil** seçimi hedef dil için değil, kullanılacak
Whisper modeli için yapılır. Bu belge 11 Ağustos 2026 tarihinde tamamlanan karşılaştırmayı ve
iki-model kararının gerekçesini açıklar.

## Teknik sınır

Whisper'ın `translate` görevi yalnız İngilizce üretir; doğrudan Türkçe hedef seçilemez.
Yabancı dildeki sesten Türkçe metin alabilmek için `task=transcribe` kullanılır ve dil token'ı
`tr` olarak zorlanır. Zorlanan dil sesle uyuşmadığında sonucun kullanılabilirliği modele bağlıdır.

## Karşılaştırma

Aynı 29,6 saniyelik sentetik İngilizce toplantı repliği, aynı q8 ve aynı chunked çözümleme
koşullarıyla işlendi. Metin; bir anlaşma, hukuk onayı, %7 oranı, örnek ürün ve geri bildirim
konularını içeriyordu.

| Model | Dil ayarı | Sonuç |
|---|---|---|
| `whisper-large-v3-turbo` | Zorlanmadı | Akıcı ve doğru İngilizce döküm |
| `whisper-large-v3-turbo` | `tr` zorlandı | Kısa bir Türkçe kalıbın tekrarladığı kullanılamaz döngü |
| `whisper-medium-ONNX` | `tr` zorlandı | Dilbilgisi kusurlu fakat ana konu ve bazı değerleri koruyan Türkçe karşılık |

Turbo model, uyuşmayan zorlanmış dilde tekrar döngüsüne girerken medium model kaba fakat
anlam taşıyan bir Türkçe çıktı üretti. Kontrol amacıyla turbo dil zorlaması olmadan aynı sesi
başarılı biçimde çözdü; dolayısıyla fark ses kalitesinden kaynaklanmadı.

## Neden bütün toplantılarda medium kullanılmıyor?

[Model seçimi karşılaştırmasında](model-selection.md) Türkçe senaryolar için toplu domain recall:

| Model | Statik | Canlı |
|---|---:|---:|
| medium q8 | 20/38 | 18/38 |
| turbo q8 | **26/38** | **25/38** |

Medium daha yavaştır ve Türkçe içindeki yabancı domain terimlerini turbo kadar iyi korumaz.
Bu nedenle iki model birlikte paketlenir:

- **Türkçe:** large-v3-turbo yolu kullanılır.
- **Yabancı dil:** medium model ile Türkçe token'ı zorlanır.

Model seçimi kullanıcı tarafından kayıt öncesinde yapıldığı için kısa veya sessiz bir açılışın
yanlış otomatik dil algılaması üretmesi engellenir.

## Sınırlar

- Ölçüm tek, sentetik, temiz ve tek konuşmacılı İngilizce sesle yapılmıştır.
- Medium çıktısı kusursuz çeviri değildir; deney yalnız kullanılabilir anlam ile tekrar döngüsünü ayırır.
- Aksan, gürültü ve üst üste konuşma içeren paylaşılabilir bir yabancı dil senaryo seti henüz yoktur.
- İngilizce dışındaki yabancı diller aynı sonucu vermeyebilir; özellik bu nedenle beta olarak sunulur.
