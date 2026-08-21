import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Analysis } from '../../engine/analyze/types/output.ts';
import {
  cleanEmptyMeetingDirectories,
  deleteMeetingCascade,
  readMeta,
  readStoredAnalysis,
  renameMeetingPair,
  resolveActiveMeetingId,
  resolveDisplayName,
  resolveOriginalMeetingId,
  revertMeetingEdit,
  saveEditedAnalysis,
  saveSpeakerNames,
} from '../meeting-edits.ts';

const ORIGINAL_ID = '2026-07-22T10-00-00-000Z';
const EDITED_ID = '2026-07-22T10-01-00-000Z';
const UNUSED_ID = '2026-07-22T10-02-00-000Z';

const originalAnalysis: Analysis = {
  status: 'success',
  markdown: '### Ana İstek ve Amaç\n\n- Original analysis',
};

const editedAnalysis: Analysis = {
  status: 'success',
  markdown: '### Ana İstek ve Amaç\n\n- Edited analysis',
};

async function tempMeetingsDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'argus-meeting-edits-'));
}

async function writeMeeting(dir: string, id = ORIGINAL_ID): Promise<void> {
  const meetingDir = path.join(dir, id);
  await fs.mkdir(meetingDir, { recursive: true });
  await fs.writeFile(
    path.join(meetingDir, 'transcribe.json'),
    JSON.stringify({ segments: [{ text: 'Transcript' }], text: 'Transcript' }),
    'utf8',
  );
  await fs.writeFile(
    path.join(meetingDir, 'analyze.json'),
    JSON.stringify({ analysis: originalAnalysis, speakersDegraded: true }),
    'utf8',
  );
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
}

test('saves all edits to one full copy and leaves the original analysis untouched', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);

  const savedId = await saveEditedAnalysis(dir, ORIGINAL_ID, editedAnalysis, EDITED_ID);
  assert.equal(savedId, EDITED_ID);
  assert.deepEqual(await readMeta(dir, ORIGINAL_ID), { editedId: EDITED_ID });
  assert.deepEqual(await readMeta(dir, EDITED_ID), { originalId: ORIGINAL_ID });
  assert.deepEqual(
    await readJson(path.join(dir, ORIGINAL_ID, 'analyze.json')),
    { analysis: originalAnalysis, speakersDegraded: true },
  );
  assert.deepEqual(
    await readJson(path.join(dir, EDITED_ID, 'analyze.json')),
    { analysis: editedAnalysis, speakersDegraded: true },
  );
  assert.deepEqual(
    await readJson(path.join(dir, EDITED_ID, 'transcribe.json')),
    await readJson(path.join(dir, ORIGINAL_ID, 'transcribe.json')),
  );

  const secondAnalysis = { ...editedAnalysis, markdown: '### Ana İstek ve Amaç\n\n- Saved again' };
  assert.equal(
    await saveEditedAnalysis(dir, ORIGINAL_ID, secondAnalysis, UNUSED_ID),
    EDITED_ID,
  );
  assert.equal(await fs.access(path.join(dir, UNUSED_ID)).then(() => true, () => false), false);
  assert.equal(await saveEditedAnalysis(dir, EDITED_ID, editedAnalysis, UNUSED_ID), EDITED_ID);
});

test('renaming either row stores one base name and resolves the edited suffix', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  await saveEditedAnalysis(dir, ORIGINAL_ID, editedAnalysis, EDITED_ID);

  await renameMeetingPair(dir, EDITED_ID, '  Weekly planning  ');
  const originalMeta = await readMeta(dir, ORIGINAL_ID);
  const editedMeta = await readMeta(dir, EDITED_ID);
  assert.deepEqual(originalMeta, { editedId: EDITED_ID, name: 'Weekly planning' });
  assert.deepEqual(editedMeta, { originalId: ORIGINAL_ID });
  assert.equal(
    await resolveDisplayName(dir, EDITED_ID, '2026-07-22T10:01:00.000Z', editedMeta),
    'Weekly planning (Edited)',
  );
});

test('deleting an edited copy preserves and leaves the original renameable', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  await saveEditedAnalysis(dir, ORIGINAL_ID, editedAnalysis, EDITED_ID);

  await deleteMeetingCascade(dir, EDITED_ID);
  assert.deepEqual(await readMeta(dir, ORIGINAL_ID), {});
  await fs.access(path.join(dir, ORIGINAL_ID, 'transcribe.json'));
  await assert.rejects(fs.access(path.join(dir, EDITED_ID)));

  await renameMeetingPair(dir, ORIGINAL_ID, 'Renamed original');
  const originalMeta = await readMeta(dir, ORIGINAL_ID);
  assert.deepEqual(originalMeta, { name: 'Renamed original' });
  assert.equal(
    await resolveDisplayName(dir, ORIGINAL_ID, '2026-07-22T10:00:00.000Z', originalMeta),
    'Renamed original',
  );
});

test('resolves an edited pair as one logical meeting with active edited content', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  await saveEditedAnalysis(dir, ORIGINAL_ID, editedAnalysis, EDITED_ID);

  assert.equal(await resolveOriginalMeetingId(dir, ORIGINAL_ID), ORIGINAL_ID);
  assert.equal(await resolveOriginalMeetingId(dir, EDITED_ID), ORIGINAL_ID);
  assert.equal(await resolveActiveMeetingId(dir, ORIGINAL_ID), EDITED_ID);
  assert.equal(await resolveActiveMeetingId(dir, EDITED_ID), EDITED_ID);
});

test('reverting from either side removes the edited copy and restores the original', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  await saveEditedAnalysis(dir, ORIGINAL_ID, editedAnalysis, EDITED_ID);

  assert.equal(await revertMeetingEdit(dir, EDITED_ID), ORIGINAL_ID);
  assert.deepEqual(await readMeta(dir, ORIGINAL_ID), {});
  assert.equal(await resolveActiveMeetingId(dir, ORIGINAL_ID), ORIGINAL_ID);
  await fs.access(path.join(dir, ORIGINAL_ID, 'analyze.json'));
  await assert.rejects(fs.access(path.join(dir, EDITED_ID)));
});

test('falls back to the original when an edited link is stale or malformed', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  await fs.writeFile(
    path.join(dir, ORIGINAL_ID, 'meta.json'),
    JSON.stringify({ editedId: EDITED_ID }),
    'utf8',
  );

  assert.equal(await resolveActiveMeetingId(dir, ORIGINAL_ID), ORIGINAL_ID);
});

test('deleting an original removes both sides of the pair', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  await saveEditedAnalysis(dir, ORIGINAL_ID, editedAnalysis, EDITED_ID);

  await deleteMeetingCascade(dir, ORIGINAL_ID);
  for (const id of [ORIGINAL_ID, EDITED_ID]) {
    await assert.rejects(fs.access(path.join(dir, id)));
  }
});

test('deleting a meeting removes extra local files with its folder', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  await fs.writeFile(path.join(dir, ORIGINAL_ID, 'extra-local-file.txt'), 'extra', 'utf8');

  await deleteMeetingCascade(dir, ORIGINAL_ID);
  await assert.rejects(fs.access(path.join(dir, ORIGINAL_ID)));
});

test('each delete also removes other empty folders below meeting storage', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  const orphan = path.join(dir, UNUSED_ID, 'empty-child');
  await fs.mkdir(orphan, { recursive: true });

  await deleteMeetingCascade(dir, ORIGINAL_ID);
  await assert.rejects(fs.access(path.join(dir, UNUSED_ID)));
  await fs.access(dir);
});

test('empty-folder cleanup is safe when meeting storage does not exist', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const missingDir = path.join(dir, 'missing');

  await cleanEmptyMeetingDirectories(missingDir);
  await assert.rejects(fs.access(missingDir));
});

test('rejects ids before joining them to the meetings directory', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(readMeta(dir, '../outside'), /Geçersiz toplantı kimliği/);
});

// --- Speaker naming ---------------------------------------------------------

const speakerAnalysis: Analysis = {
  status: 'success',
  markdown: '### Aksiyon Maddeleri\n\n- SPEAKER_01: Reçeteyi revize etmek\n- SPEAKER_00: Müşteriye bilgi vermek',
};

async function writeSpeakerMeeting(dir: string, id = ORIGINAL_ID): Promise<void> {
  const meetingDir = path.join(dir, id);
  await fs.mkdir(meetingDir, { recursive: true });
  await fs.writeFile(
    path.join(meetingDir, 'transcribe.json'),
    JSON.stringify({
      segments: [
        { start: 0, end: 1, text: 'Günaydın.', speaker: 'SPEAKER_00' },
        { start: 1, end: 2, text: 'Sensör sapma verdi.', speaker: 'SPEAKER_01' },
      ],
      text: 'SPEAKER_00: Günaydın.\nSPEAKER_01: Sensör sapma verdi.',
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(meetingDir, 'analyze.json'),
    JSON.stringify({ analysis: speakerAnalysis, speakersDegraded: false }),
    'utf8',
  );
}

test('naming speakers writes transcript and analysis into the edited copy only', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeSpeakerMeeting(dir);

  const savedId = await saveSpeakerNames(dir, ORIGINAL_ID, { SPEAKER_00: 'Ayşe' }, EDITED_ID);
  assert.equal(savedId, EDITED_ID);

  const editedTranscribe = await readJson(path.join(dir, EDITED_ID, 'transcribe.json'));
  assert.deepEqual(
    (editedTranscribe.segments as { speaker?: string }[]).map((s) => s.speaker),
    ['Ayşe', 'SPEAKER_01'],
  );
  // text is re-rendered from the renamed segments, not patched
  assert.equal(editedTranscribe.text, 'Ayşe: Günaydın.\nSPEAKER_01: Sensör sapma verdi.');
  const editedAnalyze = await readJson(path.join(dir, EDITED_ID, 'analyze.json'));
  assert.equal(
    (editedAnalyze.analysis as Analysis).markdown,
    '### Aksiyon Maddeleri\n\n- SPEAKER_01: Reçeteyi revize etmek\n- Ayşe: Müşteriye bilgi vermek',
  );
  assert.equal(editedAnalyze.speakersDegraded, false);

  const original = await readJson(path.join(dir, ORIGINAL_ID, 'transcribe.json'));
  assert.deepEqual(
    (original.segments as { speaker?: string }[]).map((s) => s.speaker),
    ['SPEAKER_00', 'SPEAKER_01'],
  );
});

test('naming twice reuses the one edited copy and undo restores the labels', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeSpeakerMeeting(dir);

  await saveSpeakerNames(dir, ORIGINAL_ID, { SPEAKER_00: 'Ayşe' }, EDITED_ID);
  assert.equal(await saveSpeakerNames(dir, ORIGINAL_ID, { Ayşe: 'Ayşe Yılmaz' }, UNUSED_ID), EDITED_ID);
  assert.equal(await fs.access(path.join(dir, UNUSED_ID)).then(() => true, () => false), false);
  const twice = await readJson(path.join(dir, EDITED_ID, 'transcribe.json'));
  assert.equal(twice.text, 'Ayşe Yılmaz: Günaydın.\nSPEAKER_01: Sensör sapma verdi.');

  await revertMeetingEdit(dir, ORIGINAL_ID);
  assert.equal(await resolveActiveMeetingId(dir, ORIGINAL_ID), ORIGINAL_ID);
  const restored = await readJson(path.join(dir, ORIGINAL_ID, 'transcribe.json'));
  assert.equal(restored.text, 'SPEAKER_00: Günaydın.\nSPEAKER_01: Sensör sapma verdi.');
});

test('an empty mapping writes nothing and creates no edited copy', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeSpeakerMeeting(dir);

  assert.equal(await saveSpeakerNames(dir, ORIGINAL_ID, {}, EDITED_ID), ORIGINAL_ID);
  assert.equal(await fs.access(path.join(dir, EDITED_ID)).then(() => true, () => false), false);
  assert.deepEqual(await readMeta(dir, ORIGINAL_ID), {});
});

test('a meeting without an analysis still gets its transcript named', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeSpeakerMeeting(dir);
  await fs.rm(path.join(dir, ORIGINAL_ID, 'analyze.json'));

  const savedId = await saveSpeakerNames(dir, ORIGINAL_ID, { SPEAKER_01: 'Mert' }, EDITED_ID);
  const edited = await readJson(path.join(dir, savedId, 'transcribe.json'));
  assert.equal(edited.text, 'SPEAKER_00: Günaydın.\nMert: Sensör sapma verdi.');
});

// readStoredAnalysis is what decides a meeting's list status ('done' vs
// 'transcript-only') AND what the detail pane renders, so every way of having no
// analysis has to answer null — otherwise the badge and the pane would disagree.
test('readStoredAnalysis returns the stored analysis with its speakersDegraded flag', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);

  assert.deepEqual(await readStoredAnalysis(dir, ORIGINAL_ID), {
    analysis: originalAnalysis,
    speakersDegraded: true,
  });
});

test('readStoredAnalysis reports no analysis for a meeting saved without one', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  // Exactly what saveMeeting leaves behind when the analysis step failed: the
  // transcript is there, analyze.json was never written.
  await fs.rm(path.join(dir, ORIGINAL_ID, 'analyze.json'));

  assert.deepEqual(await readStoredAnalysis(dir, ORIGINAL_ID), {
    analysis: null,
    speakersDegraded: false,
  });
});

test('readStoredAnalysis rejects an unreadable or unfinished analysis', async (t) => {
  const dir = await tempMeetingsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeMeeting(dir);
  const analyzePath = path.join(dir, ORIGINAL_ID, 'analyze.json');

  await fs.writeFile(analyzePath, 'not json', 'utf8');
  assert.equal((await readStoredAnalysis(dir, ORIGINAL_ID)).analysis, null);

  await fs.writeFile(analyzePath, JSON.stringify({ analysis: { status: 'pending' } }), 'utf8');
  assert.equal((await readStoredAnalysis(dir, ORIGINAL_ID)).analysis, null);

  await fs.writeFile(analyzePath, JSON.stringify({ analysis: { status: 'success' } }), 'utf8');
  assert.equal((await readStoredAnalysis(dir, ORIGINAL_ID)).analysis, null);
});
