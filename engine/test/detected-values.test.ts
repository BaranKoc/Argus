import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeDetectedValues } from '../analyze/detected-values.ts';
import { normalizeForMatch } from '../analyze/normalize.ts';

const S5C = 'Zeynep, Bornamadaki siparişin durumu ne? Sipariş numarası EK2451. Toplam 3500 metre, '
  + 'bunun 1200 metresi sevk edildi. Kalan 3200 metre ne zaman çıkar? 14 Ağustos, Perşembe. '
  + 'Peki fiyat, metre başına kaça verdik? 4,75 Euro. Geçen sefer 4,27 idi. Öztürk 500 metre ek '
  + 'talep etti ama %12,5 iskonto istiyor.';

describe('value normalization', () => {
  it('folds separators, apostrophe suffixes and percent spellings', () => {
    assert.equal(normalizeForMatch('12.500 metrelik'), '12500 metrelik');
    assert.equal(normalizeForMatch("%7.2'ye"), '%7,2ye');
    assert.equal(normalizeForMatch('yüzde 13'), '%13');
    assert.equal(normalizeForMatch("break even'dayız"), 'break evendayız');
  });

  it('keeps a decimal comma that distinguishes two values', () => {
    assert.notEqual(normalizeForMatch('%12,5'), normalizeForMatch('%12'));
  });
});

describe('detected value grounding', () => {
  it('keeps labeled values whose value half appears in the transcript', () => {
    assert.deepEqual(
      mergeDetectedValues(['sipariş numarası: EK2451', 'kalan miktar: 3200 metre'], [], S5C),
      ['sipariş numarası: EK2451', 'kalan miktar: 3200 metre'],
    );
  });

  it('drops values the transcript never states', () => {
    assert.deepEqual(mergeDetectedValues(['fiyat: 5,90 Euro'], [], S5C), []);
  });

  it('grounds a qualitative value bound to a state', () => {
    const transcript = 'Cost tarafında issue var. Margin çok düşük. Neredeyse break even’dayız.';
    assert.deepEqual(mergeDetectedValues(['durum: break even'], [], transcript), ['durum: break even']);
  });

  it('tolerates thousand separators and decimal-dot variance', () => {
    const transcript = 'Ortada 12.500 metrelik bir sipariş var ve fire %4’den %7.2’ye çıktı.';
    assert.deepEqual(
      mergeDetectedValues(['sipariş: 12500 metre', 'fire oranı: %7,2'], [], transcript),
      ['sipariş: 12500 metre', 'fire oranı: %7,2'],
    );
  });

  it('rejects a value that only matches inside a longer number', () => {
    const transcript = 'Sadece 4000 metresi fikselendi ama fabrikanın 400 çalışanı var.';
    assert.deepEqual(mergeDetectedValues(['çalışan sayısı: 40'], [], transcript), []);
    assert.deepEqual(
      mergeDetectedValues(['çalışan sayısı: 400'], [], transcript),
      ['çalışan sayısı: 400'],
    );
  });

  it('drops unlabeled prose even when every word is in the transcript', () => {
    const transcript = 'Bütçe 100 bin euro olarak belirtildi ve onaylandı.';
    assert.deepEqual(
      mergeDetectedValues(['Bütçe 100 bin euro olarak belirtildi.'], [], transcript),
      [],
    );
  });

  it('drops a label that merely repeats its own value', () => {
    const transcript = 'Toplantıyı Pazartesi yapalım, servis Salı gelsin.';
    // Değer kaybolmaz: etiketsiz çapa olarak tabandan geri gelir.
    assert.deepEqual(
      mergeDetectedValues(['pazartesi: Pazartesi', 'servis günü: Salı'], ['Pazartesi'], transcript),
      ['servis günü: Salı', 'Pazartesi'],
    );
  });

  it('keeps the last value when the speaker corrects themselves', () => {
    const transcript = 'Fire ne kadar? Yüzde 7 civarı. Ha yok dur. Yüzde 9’du geçen haftaki rapor.';
    const merged = mergeDetectedValues(
      ['fire oranı: yüzde 7', 'fire oranı: yüzde 9'],
      ['Yüzde 7', 'Yüzde 9'],
      transcript,
    );
    // Çapa tabanı kapsamayı süzülmüş listeden değil kanıtlananların tamamından okuduğu için
    // düzeltilen değer geri gelmemeli.
    assert.deepEqual(merged, ['fire oranı: yüzde 9']);
  });
});

describe('anchor recall floor', () => {
  it('appends only anchors no grounded item already covers', () => {
    const transcript = 'Zam oranı %13 civarı oldu, iskonto talebi ise %12,5.';
    assert.deepEqual(
      mergeDetectedValues(['zam oranı: %13 civarı'], ['%13', '%12,5'], transcript),
      ['zam oranı: %13 civarı', '%12,5'],
    );
  });

  it('does not treat an anchor matching mid-number as covered', () => {
    const transcript = 'Bütçe 140 bin euro, peşinat 40 bin.';
    assert.deepEqual(
      mergeDetectedValues(['bütçe: 140 bin euro'], ['40 bin'], transcript),
      ['bütçe: 140 bin euro', '40 bin'],
    );
  });

  it('treats an anchor whose unit sits in the label as covered', () => {
    const transcript = 'Fabrikanın 400 çalışanı var.';
    assert.deepEqual(
      mergeDetectedValues(['çalışan sayısı: 400'], ['400 çalışanı'], transcript),
      ['çalışan sayısı: 400'],
    );
  });

  it('caps the section so a pathological anchor list cannot flood it', () => {
    const anchors = Array.from({ length: 40 }, (_, index) => `${index + 1} adet`);
    assert.equal(mergeDetectedValues([], anchors, anchors.join(', ')).length, 24);
  });
});
