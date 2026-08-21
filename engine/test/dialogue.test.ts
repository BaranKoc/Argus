import assert from 'node:assert/strict';
import test from 'node:test';
import {
  segmentsToAnalysisText,
  segmentsToSideDialogue,
  segmentsToTranscriptText,
} from '../transcribe/dialogue.ts';
import type { Segment } from '../transcribe/transcriber.ts';

test('speaker preference changes only analysis text and preserves stored segments', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Merhaba', speaker: 'SPEAKER_01' },
    { start: 1, end: 2, text: 'Toplantıya başlayalım', speaker: 'SPEAKER_02' },
    { start: 2, end: 3, text: 'Toplantıya başlayalım', speaker: 'SPEAKER_02', duplicate: true },
  ];

  assert.equal(
    segmentsToAnalysisText(segments, true),
    'SPEAKER_01: Merhaba\nSPEAKER_02: Toplantıya başlayalım',
  );
  assert.equal(
    segmentsToAnalysisText(segments, false),
    'Merhaba Toplantıya başlayalım',
  );
  assert.equal(segments[0]?.speaker, 'SPEAKER_01');
  assert.equal(segments[2]?.duplicate, true);
});

test('the stored transcript carries the capture side alongside the speaker', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Merhaba', speaker: 'SPEAKER_01', source: 'remote' },
    { start: 1, end: 2, text: 'nasılsınız', speaker: 'SPEAKER_01', source: 'remote' },
    { start: 2, end: 3, text: 'İyiyiz', speaker: 'SPEAKER_02', source: 'local' },
  ];

  assert.equal(
    segmentsToTranscriptText(segments),
    'SPEAKER_01 (Uzak): Merhaba nasılsınız\nSPEAKER_02 (Yerel): İyiyiz',
  );
});

// The setup this feature exists for: no diarization, so there is no speaker to attribute
// to, but which side spoke is still known and still worth showing in the export.
test('without speakers the side becomes the turn label', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Fiyat listesini gönderdik', source: 'remote' },
    { start: 1, end: 2, text: 'Teşekkürler', source: 'local' },
    { start: 2, end: 3, text: 'Sevkiyat ayın 25i', source: 'local' },
  ];

  assert.equal(
    segmentsToTranscriptText(segments),
    'Uzak Konuşmacı: Fiyat listesini gönderdik\nYerel Konuşmacı: Teşekkürler Sevkiyat ayın 25i',
  );
});

// The analysed text is deliberately untouched by the local/remote work: the same segments
// must reach the LLM exactly as they did before the feature existed. The two-party opt-in
// below is the single exception, and it has to be asked for.
test('the analysed text never carries the capture side', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Merhaba', speaker: 'SPEAKER_01', source: 'remote' },
    { start: 1, end: 2, text: 'İyiyiz', speaker: 'SPEAKER_02', source: 'local' },
  ];

  assert.equal(
    segmentsToAnalysisText(segments, true),
    'SPEAKER_01: Merhaba\nSPEAKER_02: İyiyiz',
  );
  assert.equal(segmentsToAnalysisText(segments, false), 'Merhaba İyiyiz');
});

// Undiarized segments with sources render as "Uzak: ..." in the transcript, but the
// analysed text has no speaker to key on and stays the plain prose it always was.
test('the analysed text of an undiarized transcript stays plain prose', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Fiyat listesi', source: 'remote' },
    { start: 1, end: 2, text: 'teşekkürler', source: 'local' },
  ];

  assert.equal(segmentsToAnalysisText(segments, true), 'Fiyat listesi teşekkürler');
});

test('a turn too faint to place keeps its speaker and drops only the side', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Merhaba', speaker: 'SPEAKER_01', source: 'local' },
    { start: 1, end: 2, text: 'mırıltı', speaker: 'SPEAKER_02' },
  ];

  assert.equal(
    segmentsToTranscriptText(segments),
    'SPEAKER_01 (Yerel): Merhaba\nSPEAKER_02: mırıltı',
  );
});

test('an unplaceable turn in an undiarized transcript is labelled, never silently merged', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Uzaktan', source: 'remote' },
    { start: 1, end: 2, text: 'mırıltı' },
  ];

  assert.equal(segmentsToTranscriptText(segments), 'Uzak Konuşmacı: Uzaktan\nBelirsiz: mırıltı');
});

test('a transcript with neither speakers nor sides stays plain prose', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Merhaba' },
    { start: 1, end: 2, text: 'toplantıya başlayalım' },
  ];

  assert.equal(segmentsToTranscriptText(segments), 'Merhaba toplantıya başlayalım');
});

// --- Two-party meetings ----------------------------------------------------
// The user declared exactly two sides, so the side IS the speaker and is allowed into the
// analysed text — the one exception to the rule the tests above pin down.

test('a declared two-party meeting analyses from the capture sides', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Fiyat listesini gönderdik', source: 'remote' },
    { start: 1, end: 2, text: 'Teşekkürler', source: 'local' },
    { start: 2, end: 3, text: 'Sevkiyat ayın 25i', source: 'local' },
  ];

  const expected = 'Uzak Konuşmacı: Fiyat listesini gönderdik\n'
    + 'Yerel Konuşmacı: Teşekkürler Sevkiyat ayın 25i';
  assert.equal(segmentsToSideDialogue(segments), expected);
  assert.equal(segmentsToAnalysisText(segments, true, true), expected);
  // The flag decides it, not the presence of sources: the same segments without the
  // declaration are the plain prose the previous test pins down.
  assert.equal(segmentsToAnalysisText(segments, true, false), 'Fiyat listesini gönderdik Teşekkürler Sevkiyat ayın 25i');
});

// Diarization is off in this mode, so a speaker label should not exist — but if one ever
// survived, "SPEAKER_01 (Uzak)" would describe the meeting as diarized, which it is not.
test('a stray speaker label cannot turn the side back into an aside', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Merhaba', speaker: 'SPEAKER_01', source: 'remote' },
    { start: 1, end: 2, text: 'İyiyiz', speaker: 'SPEAKER_02', source: 'local' },
  ];

  assert.equal(
    segmentsToSideDialogue(segments),
    'Uzak Konuşmacı: Merhaba\nYerel Konuşmacı: İyiyiz',
  );
});

// includeSpeakers is about diarized labels, which a two-party meeting has none of. The
// declaration wins either way rather than falling back to prose on the false branch.
test('the two-party declaration outranks the speaker preference', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Uzaktan', source: 'remote' },
    { start: 1, end: 2, text: 'Yerelden', source: 'local' },
  ];

  const expected = 'Uzak Konuşmacı: Uzaktan\nYerel Konuşmacı: Yerelden';
  assert.equal(segmentsToAnalysisText(segments, true, true), expected);
  assert.equal(segmentsToAnalysisText(segments, false, true), expected);
});

// Same guard the other renderers get: a chunk-boundary repeat must not reach the LLM twice.
test('two-party analysis drops duplicate-flagged segments', () => {
  const segments: Segment[] = [
    { start: 0, end: 1, text: 'Sevkiyat ayın 25i', source: 'remote' },
    { start: 1, end: 2, text: 'Sevkiyat ayın 25i', source: 'remote', duplicate: true },
  ];

  assert.equal(segmentsToSideDialogue(segments), 'Uzak Konuşmacı: Sevkiyat ayın 25i');
});
