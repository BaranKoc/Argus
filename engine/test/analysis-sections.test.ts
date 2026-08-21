import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractEntityAnchors, extractRequestAnchors } from '../analyze/anchors.ts';
import {
  ANALYSIS_SECTIONS,
  coerceAnalysisDraft,
  parseAnalysisMarkdown,
  serializeAnalysisMarkdown,
} from '../analyze/sections.ts';

describe('analysis markdown contract', () => {
  it('always serializes nine canonical headings in order and marks empty sections', () => {
    const draft = coerceAnalysisDraft({
      mainRequest: ['Ana talep'],
      decisions: ['Karar'],
      detectedValues: ['180 bin euro'],
    });
    const markdown = serializeAnalysisMarkdown(draft);
    assert.deepEqual(
      [...markdown.matchAll(/^### (.+)$/gm)].map((match) => match[1]),
      ANALYSIS_SECTIONS.map((section) => section.title),
    );
    assert.equal((markdown.match(/- Tespit edilmedi\./g) ?? []).length, 6);
  });

  it('normalizes model bullets, deduplicates items and neutralizes raw HTML', () => {
    const draft = coerceAnalysisDraft({
      mainRequest: ['- Aynı istek', 'aynı istek', '<script>alert(1)</script>'],
    });
    assert.deepEqual(draft.mainRequest, ['Aynı istek', '&lt;script&gt;alert(1)&lt;/script&gt;']);
  });

  it('round-trips canonical markdown for section-table editing', () => {
    const source = coerceAnalysisDraft({
      mainRequest: ['**Ana istek** açıklandı.'],
      questionsAndAnswers: ['Soru soruldu ve cevaplandı.'],
    });
    assert.deepEqual(parseAnalysisMarkdown(serializeAnalysisMarkdown(source)), source);
  });
});

describe('full-transcript anchors', () => {
  it('preserves percentages, currencies and dates in transcript order', () => {
    assert.deepEqual(
      extractEntityAnchors('Bütçe yüz seksen bin euro ve teklif 180 bin euro, peşin 40 bin, 2 kişiye ihtiyaç var, oran %12,5 ve tarih 24 Temmuz 2026.'),
      ['yüz seksen bin euro', '180 bin euro', '40 bin', '2 kişiye', '%12,5', '24 Temmuz 2026'],
    );
  });

  it('captures metrage, headcount and order codes through Turkish suffixes', () => {
    assert.deepEqual(
      extractEntityAnchors('Sipariş numarası EK2451. Toplam 3500 metre, bunun 1200 metresi sevk edildi. Fabrikanın 400 çalışanı var.'),
      ['EK2451', '3500 metre', '1200 metresi', '400 çalışanı'],
    );
  });

  it('does not mistake a decimal for a date', () => {
    const anchors = extractEntityAnchors('Fire %4’den %7.2’ye çıktı, 3.2 puanlık artış. Denetim 14.08.2026’da yapılacak.');
    assert.ok(anchors.includes('14.08.2026'));
    assert.ok(anchors.includes('3.2 puanlık'));
    assert.ok(!anchors.includes('3.2'));
  });

  it('captures weekdays without swallowing look-alike verbs', () => {
    const anchors = extractEntityAnchors('Teknik servisi Salı çağıralım. Denetim haftaya perşembe günü. Salıyoruz.');
    assert.deepEqual(anchors, ['Salı', 'haftaya perşembe günü']);
  });

  it('keeps acronyms and currency codes out of the order-code pattern', () => {
    assert.deepEqual(
      extractEntityAnchors('ERP’deki SKU’ları IT’ye sordum, tutar 1500 EUR.'),
      ['1500 EUR'],
    );
  });

  it('carries direct-request sentences and nearby context into final reduction', () => {
    const anchors = extractRequestAnchors(
      'Önce demo yapıldı. Benim sorum şu. En çok işime yarayacak şey iki sesi birlikte almak. Kritik toplantıları kaçırıyoruz. Sonra PDF konuşuldu.',
    );
    assert.ok(anchors.some((anchor) => anchor.includes('iki sesi birlikte almak')));
    assert.ok(anchors.some((anchor) => anchor.includes('Kritik toplantıları kaçırıyoruz')));
    assert.equal(anchors.length, 1);
  });
});
