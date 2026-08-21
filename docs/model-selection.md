# Model Seçimi ve Transkripsiyon Performansı

[← README'ye dön](../README.md)

Bu belge Argus'un varsayılan Türkçe transkripsiyon modelinin seçildiği karşılaştırmayı ve
sonuçlarını açıklar. Ölçüm 22 Temmuz 2026 tarihinde aynı senaryo kümesi, aynı makine ve aynı
pipeline koşullarıyla tamamlanmıştır.

## Yöntem

- 14 senaryo: `S1-C`, `S1-F`, `S2-C`, `S2-F`, `S3-F`, `S4-C`, `S5-C`, `S6-C`,
  `S7-A`–`S7-E` ve `S8`.
- Her senaryo statik ve benzetilmiş canlı pipeline ile işlendi.
- Dört model konfigürasyonu karşılaştırıldı; toplam 112 transkripsiyon görevi çalıştırıldı.
- Görevler sıralı yürütüldü ve aynı anda ikinci benchmark başlamasını engelleyen kilit kullanıldı.
- Analiz aşamasında aynı yerel Ollama sağlayıcısı kullanıldı.

| Konfigürasyon | Model / dtype | Statik | Canlı |
|---|---|---:|---:|
| A | medium / q8 | 14/14 | 14/14 |
| B | large-v3-turbo / q8 | 14/14 | 14/14 |
| C | large-v3-turbo / encoder=q8, decoder=fp32 | 14/14 | 14/14 |
| D | large-v3-turbo / fp32 | 14/14 | 14/14 |

## Metriklerin anlamı

- **WER**, seçilmiş control-group transkriptinden sapmadır; mutlak doğruluk ölçüsü değildir.
- **Domain recall**, S1–S6 için belirlenmiş 38 terimin ne kadarının korunduğunu gösterir.
- **Duplicate**, **overlap** ve **hallucination** sayıları insan incelemesine yön veren sinyallerdir.
- **RTF**, transkripsiyon süresinin ses süresine oranıdır; düşük değer daha hızlıdır.

## Toplu sonuçlar

| Config | Pipeline | Koşu | Ort. WER | Recall | Ort. RTF | Duplicate | Overlap | Hallucination sinyali | Tepe RSS |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A | Statik | 14 | 0,3475 | 20/38 | 0,45 | 2 | 0 | 169 | 3.748 MB |
| A | Canlı | 14 | 0,3855 | 18/38 | 0,74 | 47 | 0 | 238 | 3.748 MB |
| B | Statik | 14 | 0,1300 | 26/38 | 0,25 | 8 | 0 | 13 | 3.624 MB |
| B | Canlı | 14 | 0,1526 | 25/38 | 0,31 | 80 | 0 | 38 | 3.744 MB |
| C | Statik | 14 | 0,0891 | 26/38 | 0,20 | 8 | 0 | 47 | 5.055 MB |
| C | Canlı | 14 | 0,1883 | 26/38 | 0,26 | 87 | 0 | 84 | 5.055 MB |
| D | Statik | 14 | 0,1230 | 26/38 | 0,29 | 8 | 0 | 73 | 7.680 MB |
| D | Canlı | 14 | 0,2872 | 26/38 | 0,43 | 89 | 0 | 144 | 7.680 MB |

Analizör 104 başarılı analiz üretti. Kalan sekiz görev, kasıtlı sessizlik senaryosu `S7-A`nın
her model/pipeline çiftindeki beklenen boş-transkript sonucudur; beklenmeyen analiz hatası yoktur.

## Senaryo bazında domain recall

| Senaryo | Terim | A statik/canlı | B statik/canlı | C statik/canlı | D statik/canlı |
|---|---:|---:|---:|---:|---:|
| S1-C | 4 | 4/4 · 3/4 | 4/4 · 4/4 | 4/4 · 4/4 | 4/4 · 4/4 |
| S1-F | 4 | 3/4 · 3/4 | 4/4 · 4/4 | 4/4 · 4/4 | 4/4 · 4/4 |
| S2-C | 4 | 2/4 · 2/4 | 2/4 · 2/4 | 2/4 · 2/4 | 2/4 · 2/4 |
| S2-F | 4 | 1/4 · 2/4 | 1/4 · 0/4 | 1/4 · 1/4 | 1/4 · 1/4 |
| S3-F | 4 | 1/4 · 0/4 | 3/4 · 2/4 | 3/4 · 2/4 | 2/4 · 2/4 |
| S4-C | 6 | 1/6 · 1/6 | 3/6 · 4/6 | 3/6 · 4/6 | 4/6 · 4/6 |
| S5-C | 6 | 4/6 · 3/6 | 5/6 · 5/6 | 5/6 · 5/6 | 5/6 · 5/6 |
| S6-C | 6 | 4/6 · 4/6 | 4/6 · 4/6 | 4/6 · 4/6 | 4/6 · 4/6 |

## Ürün kararı

- A, turbo konfigürasyonlarından daha yavaş ve domain recall açısından geridedir.
- B, yaklaşık 3,6–3,7 GB tepe bellekle turbo seçenekleri içindeki en düşük bellek yükünü verir.
- C, en iyi recall düzeyini korurken statik ve canlı pipeline'da en düşük RTF değerini üretir.
- D, C ile aynı recall düzeyinde daha yavaş çalışır ve yaklaşık 7,7 GB tepe bellek ister.

Bu nedenle Argus'un varsayılan Türkçe yolu **large-v3-turbo encoder=q8, decoder=fp32 (C)**
konfigürasyonudur. Canlı pipeline'daki duplicate sinyallerinin statikten belirgin biçimde yüksek
olması model seçimini değiştirmez; bu fark canlı parça dikişi için ayrı bir kalite hedefidir.

## Sınırlar

- Sonuçlar tek donanım ve tek tamamlanmış karşılaştırmaya aittir.
- WER, control-group sapmasını gösterir; ground-truth doğruluğu yerine kullanılamaz.
- S7 ve S8 sabit domain terimi taşımadığı için recall paydasını değiştirmez.
- Güncel pipeline davranışı değiştiğinde aynı matris yeniden çalıştırılmadan sayılar güncellenmez.
