# 🤖 AI/Agent Geliştirme Protokolü

[← README'ye dön](../README.md)

Bu belge Argus'un insan-agent işbirliğiyle nasıl geliştirildiğini ve kanıtın
nasıl kullanıldığını açıklar. Agent için bağlayıcı operasyon kuralları [AGENTS.md](../AGENTS.md)
içindedir; bu belge onun yerine geçmez.

## 🤝 Sorumluluk paylaşımı

Proje büyük ölçüde otomatik testler, control-group sonuçları ve AI agent geri bildirim döngüleriyle
geliştirildi. Ürün sahibi hedefleri, kritik şemaları, iş kurallarını, sınırları ve kabul ölçütlerini
belirledi. Agent mevcut sistemi analiz etti, çözüm tasarladı, kod ve test yazdı ve elde edilen
çıktıları değerlendirdi.

İnsan rolü yalnız satır satır kod yazmak değildir; ürün kurallarının ve geri dönüşü zor kararların
sahibidir. Agent çıktıları da yalnız üretildikleri için doğru kabul edilmez. Otomatik testler
gerekli, fakat engine kalitesi için tek başına yeterli değildir: seçilmiş senaryo çıktıları
referanslarla, metriklerle ve insan okumasıyla birlikte değerlendirilir.

## 🔄 Bugünkü çalışma döngüsü

1. **Hedef ve sınırlar:** Kullanıcı hedefi, kapsamı, kritik kuralları ve kabul ölçütlerini belirler.
2. **Bağlam incelemesi:** Agent ilgili kodu, belgeleri, control-group registry'sini ve regresyon
   geçmişini inceler.
3. **Uygulama:** Değişiklik mevcut sözleşmeler ve en dar gerekli kapsam içinde uygulanır.
4. **Otomatik doğrulama:** İlgili testler, tam test setleri ve build değişikliğin riskine uygun
   sırayla çalıştırılır.
5. **Senaryo seçimi:** Engine değişikliğinde kullanıcı etkilenen senaryoyu veya
   senaryoları çalıştırmadan önce seçer. Agent dosyayı kendiliğinden seçmez.
6. **Kanıt karşılaştırması:** Agent sonucu control-group referansı, metrikler ve gerçek metinle
   birlikte inceler. `wer` tek başına doğruluk hükmü değildir.
7. **Regresyon kaydı:** Sonuç kötüleşirse somut önce/sonra örneği tarihli olarak
   [engine regresyon günlüğüne](engine-regressions.md) eklenir.
8. **İnsan onayı:** Referans promotion, belirsiz kalite kararı ve geri dönüşü zor işlemler kullanıcı
   onayında kalır. Test çıktıları kanıt geçmişi olduğu için kendiliğinden temizlenmez.

Bu döngüde agent uygulama ve kanıt üretiminde yüksek özerklik taşır; ürün anlamı belirsiz olduğunda
veya işlem yeni yetki gerektirdiğinde kararı kullanıcıya bırakır.

## 🧾 Kanıt katmanları

| Katman | Yanıtladığı soru |
|---|---|
| Birim ve entegrasyon testleri | Kod sözleşmesi ve sınır durumları korunuyor mu? |
| Build ve paket doğrulama | Uygulama derleniyor ve dağıtılabilir varlıklar eksiksiz mi? |
| Control-group metrikleri | Yeni çıktı seçilmiş referanstan nasıl sapıyor? |
| Gerçek metin ve konuşmacı okuması | Sayıların kaçırdığı anlamsal veya atıf problemi var mı? |
| Kullanıcı kararı | Ürün açısından hangi değişim kabul edilebilir ve hangi çıktı yeni referans olmalı? |

Referanslar otomatik olarak “en yeni dosya” seçilerek değişmez. Promotion açık bir karardır;
registry hangi çıktının neden karşılaştırma tabanı olduğunu izlenebilir tutar.

## 🚀 Gelecek hedefi

Bugünkü protokol sistematik olmakla birlikte etki alanı ve senaryo seçimi için düzenli insan
yönlendirmesi gerektirir. Gelecek hedefi:

- değişiklikten etkilenen alanların daha güçlü otomatik analizi;
- gerekçeli senaryo önerisi;
- metrik ve metin farklarının birlikte otomatik yorumlanması;
- regresyonların otomatik sınıflandırılması ve raporlanması;
- agent'ın daha uzun, goal-oriented çalışma yürütebilmesi;
- insan müdahalesinin rutin kontrolden kritik ürün kararlarına yoğunlaşmasıdır.

Bu yetenekler bugün tamamlanmış değildir. Referans promotion, belirsiz kalite değerlendirmesi ve
geri dönüşü zor işlemler öngörülebilir gelecekte de insan kontrolünde kalabilir. Stratejik sıra ve
kabul yönü [yol haritasında](roadmap.md) tanımlanır.

## 🔗 Belge ilişkisi

- [README](../README.md) ürün durumunu ve kullanıcıya dönük özeti taşır.
- [Geliştirici Rehberi](developer-guide.md) komutları, test ve release akışını taşır.
- [Mimari](architecture.md) yalnız bugünkü teknik sistemi açıklar.
- [Yol Haritası](roadmap.md) gelecek otomasyon ve ürün hedeflerini taşır.
- [AGENTS.md](../AGENTS.md) agent'ın engine doğrulaması ve çıktı yönetimi için bağlayıcı kurallarıdır.
