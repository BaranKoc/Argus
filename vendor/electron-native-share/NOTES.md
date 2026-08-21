# electron-native-share — neden depoda?

**Yalnızca Windows.** Paketin `os: ["win32"]` alanı var ve kök `package.json`'da
`optionalDependencies` altında duruyor; macOS/Linux kurulumları onu atlar, kurulum
başarısız olmaz. macOS paylaşımı Electron'un kendi `ShareMenu`'sünü kullanır — bu paketin
Objective-C addon'u kullanılmaz, böylece macOS'ta ikinci bir native modül derlenip
dağıtılmak zorunda kalınmaz. Dallanma [src/main/export.ts](../../src/main/export.ts)
içindeki `sharePdf` fonksiyonunda.

Bu, npm'deki `electron-native-share@0.1.1`'in **yamalı** kopyasıdır. Upstream sürüm Windows'ta
paylaşım penceresini açıyor ama **paylaşılan dosyayı pakete koyamıyor**: mail/sohbet hedefine
gönderildiğinde ek boş gidiyor, paylaşım ekranında dosya adı da görünmüyor.

## Upstream'deki hata

`src/win32/share.cpp`, WinRT çağrılarını bir `Napi::AsyncWorker` içinde, yani libuv worker
thread'inde yapıyordu. Üç sorun:

1. `ShowShareUIForWindow` **asenkron**: hemen döner, pencerenin içeriği sonradan
   `DataRequested` geri çağrısıyla doldurulur ve bu geri çağrı, pencereyi sahiplenen
   thread'in mesaj döngüsü tarafından pompalanır. Worker thread'inde böyle bir döngü yok.
2. Upstream, `ShowShareUIForWindow`'dan hemen sonra `DataRequested` handler'ını iptal edip
   `uninit_apartment()` çağırıyordu. Windows içeriği isteyene kadar ortada handler kalmıyor.
3. `ShowShareUIForWindow`'un HRESULT'u hiç kontrol edilmiyordu, bu yüzden başarısız bir
   paylaşım bile JS tarafına `{ method: 'native' }` olarak dönüyordu.

## Yamanın yaptığı

- WinRT işi **JS ana thread'inde** (Electron'un UI thread'i — mesaj döngüsü orada) yapılır.
- `DataTransferManager`, event token'ı ve `IStorageItem` listesi dosya-static tutulur, yani
  çağrı döndükten sonra da yaşar; apartment kapatılmaz.
- Dosyalar `GetFileFromPathAsync(...).get()` ile **MTA bir worker thread'inde** çözülür.
  STA'da `.get()` mesaj döngüsünü bloke eder ve kilitlenmeye yol açar.
- `ShowShareUIForWindow` ve `GetForWindow` `check_hresult` ile sarılır; hata JS'e ulaşır.

Not: `share()` pencere açılır açılmaz döner, kullanıcının hedefi seçmesini beklemez. Yani
`{ method: 'native' }` "gönderildi" değil, "paylaşım penceresi açıldı" demektir.

## Paketleme (ileride)

Bu depoda henüz electron-builder yapılandırması yok. Eklendiğinde `.node` ikilisinin asar
arşivinin **dışında** kalması gerekir; aksi halde çalışma anında yüklenemez:

```json
"asarUnpack": ["**/node_modules/electron-native-share/prebuilds/**"]
```

## Yeniden derleme

Derlenmiş ikili (`prebuilds/win32-x64/electron-native-share.node`) depoya commit edilmiştir;
normal kurulumda `npm install` yeter, Visual Studio gerekmez. Kaynağı değiştirirsen, MSVC
Build Tools + Python kurulu bir Windows makinede:

```
cd vendor/electron-native-share
npx node-gyp rebuild
copy build\Release\native_share.node prebuilds\win32-x64\electron-native-share.node
```

(`build/` klasörü gitignore'ludur, commit edilmez.)

`install` script'i (`node-gyp-build || exit 0`) bilerek duruyor: `binding.gyp` içeren ve
kendi `install`'ı olmayan bir pakette npm **kendiliğinden `node-gyp rebuild`** çalıştırır,
bu da derleyicisi olmayan bir makinede `npm install`'ı komple düşürür. Bu script yerine
hazır prebuild'i bulur ve sessizce çıkar.
