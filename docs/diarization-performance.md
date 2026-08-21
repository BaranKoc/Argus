# Konuşmacı Ayrımı Performansı

[← README'ye dön](../README.md)

Bu belge Pyannote konuşmacı ayrımının CPU ve NVIDIA GPU üzerindeki performans karşılaştırmasını
açıklar. Ölçüm 11 Ağustos 2026 tarihinde kısa ve uzun iki ses senaryosuyla tamamlanmıştır.

## Yöntem

- Komut: `npm run diarize-bench -w engine -- --files <senaryo> --devices cpu,cuda`
- Yalnız diarization ölçüldü; Whisper çalıştırılmadı.
- Ses bir kez çözüldü ve iki aygıt aynı WAV girdisini kullandı.
- Süreler worker içinden, CUDA ölçümlerinden önce `torch.cuda.synchronize()` çağrılarak alındı.
- Her aygıt ve senaryo için bir koşu yapıldı.

**Donanım:** NVIDIA GeForce RTX 4060 Laptop, 8 GB VRAM; sürücü 577.00 / CUDA 12.9.

**Yazılım:** `pyannote.audio 4.0.0`, `torch 2.13.0+cpu` ve `torch 2.13.0+cu126`.

## Sonuçlar

| Senaryo | Ses | Aygıt | Toplam | RTF | Yükleme | Pipeline | Embed | Küme | Refine | Pencere | Konuşmacı | Turn | VRAM | RSS |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S6-C | 90,3 sn | CPU | 52,3 sn | 0,579 | 10,2 | 37,9 | 1,6 | 0,0 | 2,7 | 70 | 2 | 18 | — | 2.327 MB |
| S6-C | 90,3 sn | CUDA | 11,9 sn | 0,132 | 8,0 | 3,4 | 0,1 | 0,0 | 0,2 | 70 | 2 | 18 | 1.629 MB | 1.585 MB |
| S8 | 1.471,2 sn | CPU | 700,8 sn | 0,476 | 7,3 | 620,8 | 53,0 | 0,8 | 18,9 | 1.912 | 2 | 97 | — | 14.716 MB |
| S8 | 1.471,2 sn | CUDA | 60,8 sn | 0,041 | 6,5 | 48,6 | 3,3 | 0,7 | 1,7 | 1.912 | 2 | 97 | 1.629 MB | 1.970 MB |

Uzun S8 kaydında CPU 11,7 dakika, GPU yaklaşık 1 dakika sürdü: **11,5 kat hızlanma**.
S6-C'de hızlanma **4,4 kat** oldu.

## Ürün kararı

Model yükleme yaklaşık 7–10 saniyelik sabit maliyettir. Kayıt uzadıkça asıl pipeline hesabı
baskın hâle gelir ve GPU avantajı büyür. CPU yolu uzun senaryoda 14,7 GB tepe RSS üretirken GPU
yolu yaklaşık 2,0 GB RSS ve 1,6 GB VRAM'de kaldı.

İki aygıt da ölçülen senaryolarda aynı pencere, konuşmacı ve konuşma turu sayılarını üretti.
Performans ve bellek sonuçları birlikte değerlendirildiğinde konuşmacı ayrımı Argus'ta NVIDIA GPU
ile sunulur; GPU desteği installer'dan ayrı bir runtime arşivi olarak kurulur.

## Sınırlar

- Ölçüm tek makine, tek GPU ve her kombinasyon için tek koşuyla sınırlıdır.
- Konuşmacı/turn eşitliği kalite ground-truth'u değildir; yalnız aygıtlar arası tutarlılık sinyalidir.
- CPU yolu mini-batch uygulanmadan ölçülmüştür; sonuç mevcut CPU davranışını temsil eder.
- Daha düşük VRAM kapasitelerinde davranış ayrıca ölçülmemiştir.
