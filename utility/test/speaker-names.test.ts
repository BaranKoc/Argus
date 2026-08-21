import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyAnalysisDraft } from '../../engine/analyze/sections.ts';
import type { Segment } from '../../engine/transcribe/transcriber.ts';
import {
  analysisItemsBySpeaker,
  buildSpeakerNameMap,
  isReservedSpeakerName,
  renameAnalysisLabels,
  renameSegmentSpeakers,
  speakerLabels,
  speakerNameError,
  speakerSource,
  speakerTranscriptLines,
} from '../speaker-names.ts';

function segment(speaker: string | undefined, text: string, extra: Partial<Segment> = {}): Segment {
  return { start: 0, end: 1, text, ...(speaker ? { speaker } : {}), ...extra };
}

test('speakerLabels lists each label once, in first-appearance order', () => {
  const segments = [
    segment('SPEAKER_01', 'bir'),
    segment('SPEAKER_00', 'iki'),
    segment('SPEAKER_01', 'üç'),
    segment(undefined, 'etiketsiz'),
  ];
  assert.deepEqual(speakerLabels(segments), ['SPEAKER_01', 'SPEAKER_00']);
});

test('speakerSource reports the capture side a speaker was on', () => {
  const segments = [
    segment('SPEAKER_00', 'bir', { source: 'remote' }),
    segment('SPEAKER_01', 'iki'),
    segment('SPEAKER_01', 'üç', { source: 'local' }),
  ];
  assert.equal(speakerSource(segments, 'SPEAKER_00'), 'remote');
  // A speaker whose first segment was too faint to place still answers from the rest.
  assert.equal(speakerSource(segments, 'SPEAKER_01'), 'local');
  assert.equal(speakerSource(segments, 'SPEAKER_09'), undefined);
});

test('renameSegmentSpeakers touches only mapped labels and only the speaker field', () => {
  const segments = [
    segment('SPEAKER_00', 'bir', { duplicate: true }),
    segment('SPEAKER_01', 'iki'),
    segment(undefined, 'üç'),
  ];
  const renamed = renameSegmentSpeakers(segments, { SPEAKER_00: 'Ayşe' });
  assert.deepEqual(renamed.map((s) => s.speaker), ['Ayşe', 'SPEAKER_01', undefined]);
  assert.equal(renamed[0]!.duplicate, true);
  assert.equal(renamed[0]!.text, 'bir');
});

test('renameAnalysisLabels does not let SPEAKER_1 eat the front of SPEAKER_10', () => {
  const markdown = '- SPEAKER_1: bir\n- SPEAKER_10: on';
  const renamed = renameAnalysisLabels(markdown, { SPEAKER_1: 'Ayşe', SPEAKER_10: 'Mert' });
  assert.equal(renamed, '- Ayşe: bir\n- Mert: on');
});

test('renameAnalysisLabels applies one pass, so a rename cannot chain into another', () => {
  const renamed = renameAnalysisLabels('SPEAKER_00 ve SPEAKER_01', {
    SPEAKER_00: 'SPEAKER_01',
    SPEAKER_01: 'Mert',
  });
  assert.equal(renamed, 'SPEAKER_01 ve Mert');
});

test('renameAnalysisLabels keeps a label that is part of a longer word intact', () => {
  const renamed = renameAnalysisLabels('SPEAKER_00X ve SPEAKER_00', { SPEAKER_00: 'Ayşe' });
  assert.equal(renamed, 'SPEAKER_00X ve Ayşe');
});

test('renameAnalysisLabels handles Turkish names and an empty mapping', () => {
  assert.equal(renameAnalysisLabels('- SPEAKER_02: rapor', { SPEAKER_02: 'Şükrü Öztürk' }), '- Şükrü Öztürk: rapor');
  assert.equal(renameAnalysisLabels('- SPEAKER_02: rapor', {}), '- SPEAKER_02: rapor');
});

test('two labels may map to the same person', () => {
  const segments = [segment('SPEAKER_00', 'bir'), segment('SPEAKER_02', 'iki')];
  const mapping = { SPEAKER_00: 'Ayşe', SPEAKER_02: 'Ayşe' };
  assert.deepEqual(renameSegmentSpeakers(segments, mapping).map((s) => s.speaker), ['Ayşe', 'Ayşe']);
  assert.equal(renameAnalysisLabels('SPEAKER_00 SPEAKER_02', mapping), 'Ayşe Ayşe');
});

test('analysisItemsBySpeaker collects the speaker mentions with their section title', () => {
  const draft = emptyAnalysisDraft();
  draft.decisions = ['SPEAKER_00: bakım ertelenmeyecek', 'SPEAKER_01: reçete revize'];
  draft.risksAndBlockers = ['SPEAKER_01: kapasite düşer', 'Etiketsiz risk'];
  assert.deepEqual(analysisItemsBySpeaker(draft, 'SPEAKER_01'), [
    { sectionTitle: 'Alınan Kararlar', item: 'SPEAKER_01: reçete revize' },
    { sectionTitle: 'Riskler ve Engelleyiciler', item: 'SPEAKER_01: kapasite düşer' },
  ]);
});

test('speakerTranscriptLines skips other speakers and stitch duplicates', () => {
  const segments = [
    segment('SPEAKER_00', ' bir '),
    segment('SPEAKER_00', 'tekrar', { duplicate: true }),
    segment('SPEAKER_01', 'iki'),
  ];
  assert.deepEqual(speakerTranscriptLines(segments, 'SPEAKER_00'), ['bir']);
});

test('speakerNameError rejects what would break the dialogue format', () => {
  assert.equal(speakerNameError(''), null); // empty means "leave it alone"
  assert.equal(speakerNameError('  Ayşe '), null);
  assert.notEqual(speakerNameError('Ayşe: Mert'), null);
  assert.notEqual(speakerNameError('Ayşe\nMert'), null);
  assert.notEqual(speakerNameError('SPEAKER_04'), null);
  assert.equal(isReservedSpeakerName('speaker 4'), true);
});

test('buildSpeakerNameMap keeps only the labels that actually changed', () => {
  const mapping = buildSpeakerNameMap([
    { label: 'SPEAKER_00', name: ' Ayşe ' },
    { label: 'SPEAKER_01', name: '   ' },
    { label: 'SPEAKER_02', name: 'SPEAKER_02' },
  ]);
  assert.deepEqual(mapping, { SPEAKER_00: 'Ayşe' });
});
