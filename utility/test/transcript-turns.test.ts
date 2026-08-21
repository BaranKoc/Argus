import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTranscriptTurns } from '../transcript-turns.ts';

test('breaks a run of speaker turns into one line each', () => {
  assert.deepEqual(splitTranscriptTurns('-Şu an kayıtta alıyoruz. -Şu an kayıttayız.'), [
    '-Şu an kayıtta alıyoruz.',
    '-Şu an kayıttayız.',
  ]);
});

test('keeps the dash — it is what marks the line as another turn', () => {
  assert.deepEqual(splitTranscriptTurns('Evet, tam onu göstereyim. -Aa öyle bir şey.'), [
    'Evet, tam onu göstereyim.',
    '-Aa öyle bir şey.',
  ]);
});

test('accepts a space after the dash', () => {
  assert.deepEqual(splitTranscriptTurns('- O işe ne yaparız? - Şu an çalışmıyoruz.'), [
    '- O işe ne yaparız?',
    '- Şu an çalışmıyoruz.',
  ]);
});

// The real risk of a dash rule: cutting words in half.
test('leaves hyphenated words alone', () => {
  assert.deepEqual(
    splitTranscriptTurns('Bir de think-standardıklık yapıyorduk ya, e-posta ile.'),
    ['Bir de think-standardıklık yapıyorduk ya, e-posta ile.'],
  );
});

test('drops empty pieces and surrounding whitespace', () => {
  assert.deepEqual(splitTranscriptTurns('  Tek satır.  '), ['Tek satır.']);
  assert.deepEqual(splitTranscriptTurns('   '), []);
  assert.deepEqual(splitTranscriptTurns(''), []);
});

test('a lone dash is not a turn', () => {
  assert.deepEqual(splitTranscriptTurns('Bitti - '), ['Bitti -']);
});
