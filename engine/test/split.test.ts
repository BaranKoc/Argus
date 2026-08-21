import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitDialogue } from '../analyze/split.ts';

describe('splitDialogue', () => {
  it('keeps speaker delimiters with the right chunk', () => {
    const text = [
      'SPEAKER_00: Merhaba ekip.',
      'SPEAKER_01: Ramez arizasi icin servisle gorustum.',
      'SPEAKER_02: Denetim evraklari Carsamba teslim.',
    ].join('\n');

    const chunks = splitDialogue(text, {
      maxTokens: 12,
      overlapTokens: 0,
      charsPerToken: 3.5,
    });

    assert.ok(chunks.length >= 2);
    assert.ok(
      chunks.slice(1).some((chunk) => chunk.includes('SPEAKER_01:') || chunk.includes('SPEAKER_02:')),
    );
  });

  it('produces chunks near max token budget before overlap', () => {
    const text = 'a '.repeat(600).trim();
    const chunks = splitDialogue(text, {
      maxTokens: 50,
      overlapTokens: 0,
      charsPerToken: 1,
    });

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 55, `chunk too large: ${chunk.length}`);
    }
  });

  it('adds overlap tail to following chunks', () => {
    const text =
      'Birinci cumle burada biter. Ikinci cumle devam eder. Ucuncu cumle hedef. Dorduncu cumle son.';
    const chunks = splitDialogue(text, {
      maxTokens: 12,
      overlapTokens: 4,
      charsPerToken: 3,
    });

    assert.ok(chunks.length >= 2);
    assert.ok(chunks[1].includes('cumle'));
  });

  it('returns single chunk for short input', () => {
    const text = 'Kisa bir toplanti notu.';
    const chunks = splitDialogue(text, {
      maxTokens: 200,
      overlapTokens: 20,
      charsPerToken: 3.5,
    });

    assert.deepEqual(chunks, [text]);
  });
});
