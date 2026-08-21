import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { segmentsToDialogue, type Analysis, type Transcript } from '../../engine/index.ts';
import { readMeta, saveEditedAnalysis, writeMeta } from '../../utility/meeting-edits.ts';
import {
  MeetingReanalysisCoordinator,
  prepareTranscriptForReanalysis,
  reanalyzeMeetingAnalysis,
  type AnalyzeMeeting,
} from './meeting-reanalysis.ts';

const ORIGINAL_ID = '2026-07-22T10-00-00-000Z';
const EDITED_ID = '2026-07-22T10-01-00-000Z';
const originalAnalysis: Analysis = { status: 'success', markdown: 'Original analysis' };
const editedAnalysis: Analysis = { status: 'success', markdown: 'Edited analysis' };
const newAnalysis: Analysis = { status: 'success', markdown: 'Fresh analysis' };

// prepareTranscriptForReanalysis hands `analyze` either a Transcript or finished text (the
// two-party path). Everything below except the two-party tests expects the Transcript.
function asTranscript(value: string | Transcript): Transcript {
  assert.notEqual(typeof value, 'string', 'beklenen Transcript, metin geldi');
  return value as Transcript;
}

async function fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-reanalysis-'));
  const meetingDir = path.join(dir, ORIGINAL_ID);
  await fs.mkdir(meetingDir, { recursive: true });
  await fs.writeFile(
    path.join(meetingDir, 'transcribe.json'),
    JSON.stringify({ segments: [{ text: 'Original transcript', speaker: 'SPEAKER_01' }], text: 'Original transcript' }),
    'utf8',
  );
  await fs.writeFile(
    path.join(meetingDir, 'analyze.json'),
    JSON.stringify({ analysis: originalAnalysis, speakersDegraded: true, source: 'preserved' }),
    'utf8',
  );
  await writeMeta(dir, ORIGINAL_ID, { name: 'Weekly planning' });
  await saveEditedAnalysis(dir, ORIGINAL_ID, editedAnalysis, EDITED_ID);
  await fs.writeFile(
    path.join(dir, EDITED_ID, 'transcribe.json'),
    JSON.stringify({ segments: [{ text: 'Edited transcript' }], text: 'Edited transcript' }),
    'utf8',
  );
  return dir;
}

test('reanalyzes only the original transcript then replaces the original analysis', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let receivedSegments: Transcript['segments'] = [];

  const id = await reanalyzeMeetingAnalysis(dir, EDITED_ID, { includeSpeakers: true }, async (transcript) => {
    receivedSegments = asTranscript(transcript).segments;
    return newAnalysis;
  });

  assert.equal(id, ORIGINAL_ID);
  assert.equal(receivedSegments[0]?.text, 'Original transcript');
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dir, ORIGINAL_ID, 'analyze.json'), 'utf8')),
    { analysis: newAnalysis, speakersDegraded: true, source: 'preserved' },
  );
  assert.deepEqual(await readMeta(dir, ORIGINAL_ID), { name: 'Weekly planning' });
  await assert.rejects(fs.access(path.join(dir, EDITED_ID)));
});

test('analysis failure preserves original and edited files and their metadata', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const originalBefore = await fs.readFile(path.join(dir, ORIGINAL_ID, 'analyze.json'), 'utf8');
  const editedBefore = await fs.readFile(path.join(dir, EDITED_ID, 'analyze.json'), 'utf8');
  const metaBefore = await readMeta(dir, ORIGINAL_ID);

  await assert.rejects(
    reanalyzeMeetingAnalysis(dir, ORIGINAL_ID, { includeSpeakers: true }, async () => {
      throw new Error('LLM unavailable');
    }),
    /LLM unavailable/,
  );

  assert.equal(await fs.readFile(path.join(dir, ORIGINAL_ID, 'analyze.json'), 'utf8'), originalBefore);
  assert.equal(await fs.readFile(path.join(dir, EDITED_ID, 'analyze.json'), 'utf8'), editedBefore);
  assert.deepEqual(await readMeta(dir, ORIGINAL_ID), metaBefore);
});

test('creates an analysis file when a degraded saved meeting has none', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.rm(path.join(dir, EDITED_ID), { recursive: true, force: true });
  await writeMeta(dir, ORIGINAL_ID, { name: 'Weekly planning' });
  await fs.rm(path.join(dir, ORIGINAL_ID, 'analyze.json'));

  await reanalyzeMeetingAnalysis(
    dir,
    ORIGINAL_ID,
    { includeSpeakers: true },
    async () => newAnalysis,
  );

  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dir, ORIGINAL_ID, 'analyze.json'), 'utf8')),
    { analysis: newAnalysis },
  );
});

test('coordinator rejects a second concurrent analysis for the same logical meeting', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const coordinator = new MeetingReanalysisCoordinator();
  let finish!: (analysis: Analysis) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const waiting: AnalyzeMeeting = () => new Promise((resolve) => {
    finish = resolve;
    markStarted();
  });

  const first = coordinator.run(dir, ORIGINAL_ID, { includeSpeakers: true }, waiting);
  await started;
  await assert.rejects(
    coordinator.run(dir, EDITED_ID, { includeSpeakers: true }, waiting),
    /yeniden analiz zaten devam ediyor/,
  );
  finish(newAnalysis);
  assert.equal(await first, ORIGINAL_ID);
});

test('speaker setting changes only the analyzer input and keeps transcript text intact', () => {
  const segments: Transcript['segments'] = [
    { start: 0, end: 1, text: 'Alpha', speaker: 'SPEAKER_01' },
    { start: 1, end: 2, text: 'Beta', speaker: 'SPEAKER_02' },
    { start: 2, end: 3, text: 'Repeated', speaker: 'SPEAKER_02', duplicate: true },
  ];

  const attributed = asTranscript(prepareTranscriptForReanalysis(segments, { includeSpeakers: true }));
  const anonymous = asTranscript(prepareTranscriptForReanalysis(segments, { includeSpeakers: false }));

  assert.equal(segmentsToDialogue(attributed.segments), 'SPEAKER_01: Alpha\nSPEAKER_02: Beta');
  assert.equal(segmentsToDialogue(anonymous.segments), 'Alpha Beta');
  assert.equal(anonymous.segments.some((segment) => segment.speaker), false);
  assert.equal(segments[0]?.speaker, 'SPEAKER_01');
  assert.equal(anonymous.segments[2]?.duplicate, true);
});

// A two-party meeting has no diarized speakers to keep or strip — its attribution lives in
// the capture side, which analyze() would drop if handed a Transcript. So it gets text.
test('a two-party meeting is reanalyzed from the capture sides', () => {
  const segments: Transcript['segments'] = [
    { start: 0, end: 1, text: 'Fiyat listesi', source: 'remote' },
    { start: 1, end: 2, text: 'Teşekkürler', source: 'local' },
  ];

  const prepared = prepareTranscriptForReanalysis(segments, {
    includeSpeakers: true,
    meetingScope: 'two-party',
  });

  assert.equal(prepared, 'Uzak Konuşmacı: Fiyat listesi\nYerel Konuşmacı: Teşekkürler');
  // And the group path over the same segments still goes through the Transcript.
  assert.equal(
    typeof prepareTranscriptForReanalysis(segments, { includeSpeakers: true, meetingScope: 'group' }),
    'object',
  );
});

// The scope is a fact about the recording, so it comes off disk — the reanalysis dialog
// asks about speakers and has no business revising how many parties were in the room.
test('the scope is read from the stored meeting, not from the caller', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, ORIGINAL_ID, 'transcribe.json'),
    JSON.stringify({
      segments: [
        { text: 'Fiyat listesi', source: 'remote' },
        { text: 'Teşekkürler', source: 'local' },
      ],
      text: 'Uzak Konuşmacı: Fiyat listesi',
      meetingScope: 'two-party',
    }),
    'utf8',
  );

  let received: string | Transcript = '';
  await reanalyzeMeetingAnalysis(dir, ORIGINAL_ID, { includeSpeakers: false }, async (transcript) => {
    received = transcript;
    return newAnalysis;
  });

  assert.equal(received, 'Uzak Konuşmacı: Fiyat listesi\nYerel Konuşmacı: Teşekkürler');
});

// Every meeting recorded before the option existed has no such field, and those were all
// group meetings — reading them as two-party would rewrite their analysis input.
test('a meeting saved without a scope is reanalyzed as a group meeting', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let received: string | Transcript = '';
  await reanalyzeMeetingAnalysis(dir, ORIGINAL_ID, { includeSpeakers: true }, async (transcript) => {
    received = transcript;
    return newAnalysis;
  });

  assert.equal(asTranscript(received).segments[0]?.text, 'Original transcript');
});
