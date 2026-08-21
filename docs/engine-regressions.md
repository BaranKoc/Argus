# Engine Regresyon Günlüğü

[← README'ye dön](../README.md)

Bu günlük, bir engine değişikliğinin seçilmiş control-group referansına göre gerçek çıktıyı
kötüleştirdiği doğrulanırsa kullanılır. WER tek başına doğruluk hükmü değildir; kayıt eklemek için
metrik ile insan okuması aynı somut gerilemeyi göstermelidir.

## Kayıt kuralı

1. Kullanıcı değişiklikten etkilenebilecek senaryoyu çalıştırmadan önce seçer.
2. `npm run test-run -w engine` ile yeni çıktı üretilir.
3. Metrikler ve gerçek metin seçilmiş referansla karşılaştırılır.
4. Kötüleşme varsa aşağıdaki şablonla en yeni kayıt üste eklenir.
5. Yeni çıktının referans yapılması ayrı kullanıcı onayı gerektirir.

```markdown
### YYYY-MM-DD — <özellik veya branch> — <senaryo>

- **Gerileyen davranış:**
- **Referans:**
- **Yeni çıktı:**
- **Olası neden:**
```

## Kayıtlar

v0.1.0 başlangıç durumunda kayıtlı bir sürüm sonrası regresyon yoktur.
