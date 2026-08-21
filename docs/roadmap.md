# Argus Yol Haritası

[← README](../README.md)

Argus, toplantı verisini kullanıcının kontrolünde tutan local-first bir masaüstü ürünüdür.
Merkezi yetenekler eklendiğinde de yerel kullanım bağımsız çalışmaya devam edecek ve uzak
servislere bağlantı isteğe bağlı olacaktır.

## v0.1.0 — Yerel toplantı asistanı

- Mikrofon ve sistem sesini birlikte kaydetme
- Cihaz üzerinde Whisper transkripsiyonu
- Yerel/Uzak kaynak atfı ve isteğe bağlı Pyannote konuşmacı ayrımı
- Yerel veya seçilen bulut sağlayıcısıyla yapılandırılmış toplantı analizi
- Düzenlenebilir toplantı arşivi ile PDF/Markdown dışa aktarma
- Control-group, otomatik metrikler ve insan okumasını birleştiren kalite akışı

## v0.2 — Dinamik niyet analizi

- Sabit talep kalıplarını birincil sinyal olmaktan çıkaran bağlamsal niyet çıkarımı
- Açık taleplerin yanında örtük hedef, öncelik, koşul ve gerekçelerin döküme dayalı belirlenmesi
- Uzun toplantılarda niyetlerin parçalar arasında korunması, birleştirilmesi ve önem sırasına alınması
- Her çıkarımın dökümdeki dayanağa bağlanması; model varsayımı ve uydurma niyetlerin elenmesi
- Sayı, tarih ve kod gibi deterministik çapaların doğrulama tabanı olarak korunması

## v0.3 — Kurumsal veri havuzu

- Toplantı, karar, aksiyon ve risklerin izinli ve aranabilir ortak bilgi alanında birleştirilmesi
- Organizasyon ve çalışma alanı sınırlarıyla rol tabanlı erişim
- Saklama, silme ve dışa aktarma politikaları
- Değişiklik geçmişi, veri kaynağı ve erişim hareketleri için denetim kaydı
- Yerel arşivden merkezi havuza açık kullanıcı seçimiyle veri aktarımı

## v0.4 — Merkezi Argus platformu

- Masaüstü istemciler için isteğe bağlı merkezi bağlantı ve ekip erişimi
- Model, sağlayıcı ve güvenlik politikalarının merkezi yönetimi
- Kurumsal veri havuzu üzerinde API ve webhook yüzeyi
- Entegrasyon sağlığı, kuyruklar ve analiz işleri için merkezi gözlemlenebilirlik
- Yerel bağlantı kesildiğinde kayıt ve transkripsiyonun kesintisiz devam etmesi

## Sürekli ürün kalitesi

- Windows build ve release doğrulamasının otomasyonu
- İmzalama, checksum ve üçüncü taraf model/runtime lisans bildirimleri
- Sentetik ve paylaşım izni açık senaryolarla transkripsiyon, diarization ve analiz regresyonları
- Uzun toplantılarda canlı dikiş tekrarları ile yabancı dil kalitesinin iyileştirilmesi
