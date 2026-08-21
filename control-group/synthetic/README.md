# Sentetik analiz fixture'ları

[← control-group.md](../control-group.md)

S9 ve S10'un transkript referansları elle yazılmış sentetik metinlerdir. Gerçek toplantı
değildirler; kişi, şirket ve ürün adları uydurmadır. Kaynak metinler burada tutulur;
üretilen JSON dosyaları yerel control-group girdileridir ve `.gitignore` kapsamındadır.

Temiz bir klonda fixture üreticisi hedef klasörünü kendisi oluşturur:

```powershell
node control-group/synthetic/build-fixture.mjs control-group/synthetic/S9.txt control-group/transcribe/S9_transcribe.json S9
node control-group/synthetic/build-fixture.mjs control-group/synthetic/S10.txt control-group/transcribe/S10_transcribe.json S10
```

Metin biçimi satır başına bir konuşma sırasıdır. `[[LOOP:metin:n]]` satırı, `metin` değerini
`n` kez tekrarlayan konuşma sırasına açılır.

## Neden bozuk metin kullanılıyor?

Bu fixture'lar analizörün ASR kaynaklı tekrarlar, yanlış duyumlar ve yarım cümleler içeren
girdilerle nasıl davrandığını sınar. Bu bozulmalar test verisinin bilinçli parçasıdır; metni
akıcılık için düzeltmek fixture'ın sınadığı davranışı ortadan kaldırır.

## Korunması gereken özellikler

| Özellik | S9 | S10 |
|---|---|---|
| Kod yolu | Tek geçiş (`shouldUseSinglePass` true) | Map-reduce (çok parçalı) |
| Uzunluk | Yaklaşık 2,4 bin karakter | Yaklaşık 14 bin karakter; map-reduce eşiğinde kalmalı |
| Döngü payı | %0 | Yaklaşık %4,5 |

Map-reduce eşiği `numCtx`, ayrılmış yanıt bütçesi ve `charsPerToken` değerlerinden hesaplanır
(`engine/analyze/pipeline.ts`, `engine/models.ts`). S10 eşik altına düşerse iki fixture aynı
tek-geçiş yolunu sınamaya başlar.

## S9'un test ettiği risk

S9, dökümde geçen fakat anlamlı toplantı değeri olmayan ifadelerin `Tespit Edilen Değerler`
bölümüne yanlış-pozitif olarak taşınmasını görünür tutar. Bu nedenle metinde şu üç tetikleyici
sınıfı korunur:

- bozulmuş bir sistem adı (`Kayıt Küprüsü`);
- açık bir çıktı formatı (`PDF`);
- sayı benzeri bir nitelik (`üç kanal` ve bozulmuş `iki sinya`).

Bu ifadeler kaldırılırsa S9 kısa ve temiz bir analiz örneğine dönüşür, amaçladığı yanlış-pozitif
sınırını artık test etmez.
