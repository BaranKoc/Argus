# Control Group

[← README'ye dön](../README.md)

Her senaryonun **referans çıktısı**. `npm run bench` ve `npm run test-run` wer / halüsinasyon
metriklerini buradaki dosyalara göre hesaplar.

Bu registry dosyası git ile takip edilir; gerçek referans JSON'ları ise kişisel veya kurumsal
toplantı içerebildiği için `/control-group/**/*.json` kuralıyla yerelde tutulur. Klonlayan kişi
senaryo yollarını görür ama özel dökümleri almaz. Public örnekler yalnızca sentetik veya açıkça
paylaşım izni verilmiş içerikten üretilip inceleme sonrasında bilinçli olarak eklenir. `output/`
(tek kullanımlık `test_run/` + `bench/` çalışmaları) da yok sayılmaya devam eder.

**Bu dosya elle düzenlenir ama `npm run promote` da yazar.** Kod klasörde "en yenisi hangisi"
tahmini yürütmez — referans olmak bir *karar*, dosya tarihi değil. Bir çalışmayı referans yapmak
için: `npm run promote -w engine -- <output/…/{transcribe,analyze}/…json>`; araç dosyayı
`control-group/` altına kopyalar ve aşağıdaki ilgili hücreyi günceller.

- Yollar `control-group/` köküne göredir ve **ileri eğik çizgi** kullanır (paylaşıldığı için
  makineler arası taşınabilir): `transcribe/…json` ya da `analyze/…json`. Her senaryonun her türü
  için tam **bir** referans dosyası tutulur.
- Boş hücre (`-`) = o senaryo için referans yok. Metrik `n/a` gelir; **hata değildir**.
- Bir referansın içindeki `metrics.referencePath`, o koşunun **üretildiği anda** neyle
  karşılaştırıldığını söyler — yani bir önceki referansı. Canlı bir işaretçi değil, soy kaydıdır;
  referanslar topluca yenilendikten sonra artık var olmayan bir dosyayı gösterebilir. Bir senaryonun
  güncel referansı **her zaman aşağıdaki tablodur**, JSON'un içindeki bu alan değil.

**S9 ve S10 birer analiz fixture'ıdır — transkripsiyon referansı değildirler.** S1–S8'in aksine
`test_media/` altında sesleri yoktur, dolayısıyla **yeniden transkribe edilemezler**. Transkript
sütunları bir kalite ölçütü değil, analizöre verilen **sabit girdidir**; kasten kusurludur (ASR
döngüleri, yanlış duyumlar) çünkü sınadıkları şey analizörün bozuk girdiyle başa çıkışıdır.
Yalnız `analyze` sütunları yenilenir: `printf 'S9\n\n' | npm run test-run -w engine`. `live`
sütunları kalıcı olarak boştur.

Her ikisinin transkripti **sentetiktir** — elle yazılmıştır, gerçek toplantı değildir; kişi,
şirket ve ürün adları uydurmadır. Kaynak metinler ile üretici betik
`control-group/synthetic/` altındadır. Düzenlemeden önce oradaki README'yi okuyun: uzunlukları
farklı kod yollarını (tek geçiş ve map-reduce) sınar, S9 ise nitel değerlerde yanlış-pozitif
üretme riskini görünür tutar.

| dosya | transcribe | analyze | live transcribe | live analyze |
|---|---|---|---|---|
| S1-C | transcribe/S1-C_transcribe.json | analyze/S1-C_analyze.json | live/transcribe/S1-C_live-transcribe.json | live/analyze/S1-C_live-analyze.json |
| S1-F | transcribe/S1-F_transcribe.json | analyze/S1-F_analyze.json | live/transcribe/S1-F_live-transcribe.json | live/analyze/S1-F_live-analyze.json |
| S2-C | transcribe/S2-C_transcribe.json | analyze/S2-C_analyze.json | live/transcribe/S2-C_live-transcribe.json | live/analyze/S2-C_live-analyze.json |
| S2-F | transcribe/S2-F_transcribe.json | analyze/S2-F_analyze.json | live/transcribe/S2-F_live-transcribe.json | live/analyze/S2-F_live-analyze.json |
| S3-F | transcribe/S3-F_transcribe.json | analyze/S3-F_analyze.json | live/transcribe/S3-F_live-transcribe.json | live/analyze/S3-F_live-analyze.json |
| S4-C | transcribe/S4-C_transcribe.json | analyze/S4-C_analyze.json | live/transcribe/S4-C_live-transcribe.json | live/analyze/S4-C_live-analyze.json |
| S5-C | transcribe/S5-C_transcribe.json | analyze/S5-C_analyze.json | live/transcribe/S5-C_live-transcribe.json | live/analyze/S5-C_live-analyze.json |
| S6-C | transcribe/S6-C_transcribe.json | analyze/S6-C_analyze.json | live/transcribe/S6-C_live-transcribe.json | live/analyze/S6-C_live-analyze.json |
| S7-A | transcribe/S7-A_transcribe.json | analyze/S7-A_analyze.json | - | - |
| S7-B | transcribe/S7-B_transcribe.json | analyze/S7-B_analyze.json | live/transcribe/S7-B_live-transcribe.json | live/analyze/S7-B_live-analyze.json |
| S7-C | transcribe/S7-C_transcribe.json | analyze/S7-C_analyze.json | live/transcribe/S7-C_live-transcribe.json | live/analyze/S7-C_live-analyze.json |
| S7-D | transcribe/S7-D_transcribe.json | analyze/S7-D_analyze.json | live/transcribe/S7-D_live-transcribe.json | live/analyze/S7-D_live-analyze.json |
| S7-E | transcribe/S7-E_transcribe.json | analyze/S7-E_analyze.json | live/transcribe/S7-E_live-transcribe.json | live/analyze/S7-E_live-analyze.json |
| S8 | transcribe/S8_transcribe.json | analyze/S8_analyze.json | live/transcribe/S8_live-transcribe.json | live/analyze/S8_live-analyze.json |
| S9 | transcribe/S9_transcribe.json | analyze/S9_analyze.json | - | - |
| S10 | transcribe/S10_transcribe.json | analyze/S10_analyze.json | - | - |

