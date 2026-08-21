import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAnalyzer } from '../analyze/analyzer.ts';
import { removeUnlabeledSpeakerAttributions } from '../analyze/pipeline.ts';
import type { AnalysisDraft } from '../analyze/sections.ts';
import type { ChatRequest, LlmClient } from '../analyze/llm/client.ts';
import type { LlmConfig } from '../models.ts';

const CONFIG: LlmConfig = {
  model: 'fake',
  host: 'http://localhost',
  temperature: 0,
  numCtx: 8192,
  timeoutMs: 1000,
  maxRetries: 0,
  mapConcurrency: 2,
  chunkTokens: 2200,
  chunkOverlapTokens: 0,
  charsPerToken: 3.5,
};

function draft(overrides: Partial<AnalysisDraft> = {}): AnalysisDraft {
  return {
    mainRequest: [],
    contextAndTopics: [],
    decisions: [],
    rejectedOrDeferred: [],
    actionItems: [],
    questionsAndAnswers: [],
    risksAndBlockers: [],
    nextSteps: [],
    detectedValues: [],
    ...overrides,
  };
}

class FakeClient implements LlmClient {
  readonly calls: ChatRequest[] = [];

  async chat(request: ChatRequest): Promise<unknown> {
    this.calls.push(request);
    if (request.user.includes('Kısmi analiz')) {
      return draft({
        mainRequest: ['Uzun toplantının ana isteği birleştirildi.'],
        contextAndTopics: ['Kısmi analizler tek sonuçta birleştirildi.'],
      });
    }
    if (request.user.includes('DÖKÜM PARÇASI')) {
      const part = /DÖKÜM PARÇASI (\d+)\//.exec(request.user)?.[1] ?? '?';
      return draft({ contextAndTopics: [`${part}. parça incelendi.`] });
    }
    return draft({
      mainRequest: ['Raporun hazırlanması istendi.'],
      actionItems: ['**Zeynep**, raporu yarın gönderecek.'],
      detectedValues: ['bütçe: **100 bin euro**', 'ciro: 900 bin euro'],
    });
  }
}

describe('markdown analysis pipeline', () => {
  it('uses one full-transcript call when input fits configured context', async () => {
    const client = new FakeClient();
    const analyze = createAnalyzer({ client, config: CONFIG });
    const result = await analyze(
      'Benim sorum raporun hazırlanması. Zeynep raporu yarın gönderecek. Bütçe 100 bin euro.',
    );

    assert.equal(result.status, 'success');
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].user, /TAM TOPLANTI DÖKÜMÜ/);
    assert.match(client.calls[0].user, /Doğrudan talep çapaları/);
    assert.match(client.calls[0].user, /100 bin euro/);
    assert.deepEqual(Object.keys(client.calls[0].schema?.properties as object), [
      'mainRequest',
      'contextAndTopics',
      'decisions',
      'rejectedOrDeferred',
      'actionItems',
      'questionsAndAnswers',
      'risksAndBlockers',
      'nextSteps',
      'detectedValues',
    ]);
    assert.match(result.markdown, /^### Ana İstek ve Amaç/m);
    assert.match(result.markdown, /### Aksiyon Maddeleri\n\n- \*\*Zeynep\*\*/);
    assert.match(result.markdown, /### Riskler ve Engelleyiciler\n\n- Tespit edilmedi\./);
    // Dökümde geçen değer modelin etiketiyle çıkar, geçmeyen sessizce düşer.
    assert.match(result.markdown, /### Tespit Edilen Değerler\n\n- bütçe: \*\*100 bin euro\*\*/);
    assert.doesNotMatch(result.markdown, /900 bin euro/);
  });

  it('maps long transcripts in chunks and reduces them to the same markdown contract', async () => {
    const client = new FakeClient();
    const analyze = createAnalyzer({
      client,
      config: { ...CONFIG, numCtx: 6144, chunkTokens: 400 },
    });
    const transcript = Array.from(
      { length: 300 },
      (_, index) => `Toplantının ${index + 1}. ayrıntılı konusu ve gerekçesi görüşüldü.`,
    ).join(' ');

    const result = await analyze(transcript);
    const mapCalls = client.calls.filter((call) => call.user.includes('DÖKÜM PARÇASI'));
    const reduceCalls = client.calls.filter((call) => call.user.includes('Kısmi analiz'));
    assert.ok(mapCalls.length > 1, 'expected more than one map call');
    assert.ok(reduceCalls.length >= 1, 'expected at least one reduce call');
    assert.match(result.markdown, /Uzun toplantının ana isteği birleştirildi/);
    assert.equal((result.markdown.match(/^### /gm) ?? []).length, 9);
  });

  it('keeps prompts neutral about speakers and separates assigned actions from next steps', async () => {
    const client = new FakeClient();
    await createAnalyzer({ client, config: CONFIG })('Kısa toplantı metni.');
    const system = client.calls[0].system;
    assert.match(system, /Dökümde geçmeyen müşteri temsilcisi, satıcı veya karşı taraf gibi roller üretme/);
    assert.match(system, /Aksiyon Maddeleri yalnız açıkça\nadı veya rolü belli birine atanmış görevleri/);
    assert.match(system, /"katılımcı" sorumlu kişi değildir/);
    assert.match(system, /ASR kaynaklı bir ifade Türkçe olarak ayrıştırılamıyor/);
    assert.match(client.calls[0].user, /"samam" veya "tamam" konuşmacı olamaz/);
  });

  it('moves invented speaker attributions out of assigned actions when labels are absent', () => {
    const result = removeUnlabeledSpeakerAttributions(
      draft({ actionItems: ['Hukuka gönderilecek (Konuşmacı: Samam).'] }),
      'Samam o zaman ben hukuka yollarım.',
    );
    assert.deepEqual(result.actionItems, []);
    assert.deepEqual(result.nextSteps, ['Hukuka gönderilecek']);
  });
});
