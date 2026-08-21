import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Analysis } from '../engine/analyze/types/output.ts';
// Straight from dialogue.ts rather than the engine index: this is pure text shaping over
// segments, and the index would drag the whole transcribe/analyze orchestration in with it.
import { segmentsToTranscriptText } from '../engine/transcribe/dialogue.ts';
import type { Segment } from '../engine/transcribe/transcriber.ts';
import { idToDate } from './meeting-id.ts';
import {
  renameAnalysisLabels,
  renameSegmentSpeakers,
  type SpeakerNameMap,
} from './speaker-names.ts';

export interface MeetingMeta {
  name?: string;
  originalId?: string;
  editedId?: string;
}

function meetingPath(dir: string, id: string): string {
  if (!idToDate(id)) throw new Error(`Geçersiz toplantı kimliği: ${id}`);
  return path.join(dir, id);
}

export async function readMeta(dir: string, id: string): Promise<MeetingMeta> {
  const file = path.join(meetingPath(dir, id), 'meta.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as MeetingMeta;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeMeta(dir: string, id: string, meta: MeetingMeta): Promise<void> {
  const meetingDir = meetingPath(dir, id);
  await fs.mkdir(meetingDir, { recursive: true });
  await fs.writeFile(path.join(meetingDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

export function formatMeetingName(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export async function resolveDisplayName(
  dir: string,
  id: string,
  createdAt: string,
  meta: MeetingMeta,
): Promise<string> {
  if (!meta.originalId) return meta.name ?? formatMeetingName(createdAt);

  const originalDate = idToDate(meta.originalId);
  if (!originalDate) throw new Error(`Geçersiz orijinal toplantı kimliği: ${meta.originalId}`);
  const originalMeta = await readMeta(dir, meta.originalId);
  const baseName = originalMeta.name ?? formatMeetingName(originalDate.toISOString());
  return `${baseName} (Edited)`;
}

export async function resolveOriginalMeetingId(dir: string, id: string): Promise<string> {
  const meta = await readMeta(dir, id);
  return meta.originalId ?? id;
}

export async function resolveActiveMeetingId(dir: string, id: string): Promise<string> {
  const originalId = await resolveOriginalMeetingId(dir, id);
  const originalMeta = await readMeta(dir, originalId);
  if (!originalMeta.editedId) return originalId;

  try {
    const editedMeta = await readMeta(dir, originalMeta.editedId);
    if (editedMeta.originalId !== originalId) return originalId;
    await fs.access(path.join(meetingPath(dir, originalMeta.editedId), 'transcribe.json'));
    return originalMeta.editedId;
  } catch {
    return originalId;
  }
}

export async function createEditedCopy(
  dir: string,
  originalId: string,
  newId: string,
): Promise<void> {
  const originalDir = meetingPath(dir, originalId);
  const editedDir = meetingPath(dir, newId);
  const originalMeta = await readMeta(dir, originalId);
  if (originalMeta.originalId) {
    throw new Error('Düzenlenmiş bir toplantıdan yeni bir kopya oluşturulamaz.');
  }

  await fs.mkdir(editedDir, { recursive: false });
  await fs.copyFile(path.join(originalDir, 'transcribe.json'), path.join(editedDir, 'transcribe.json'));
  // analyze.json is optional: a degraded run saves the transcript without one, and
  // readMeeting already reads that as "no analysis" rather than a failure. Copying it
  // unconditionally made every edit on such a meeting die with ENOENT.
  try {
    await fs.copyFile(path.join(originalDir, 'analyze.json'), path.join(editedDir, 'analyze.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeMeta(dir, newId, { originalId });
  await writeMeta(dir, originalId, { ...originalMeta, editedId: newId });
}

// The counterpart to overwriteAnalysis, and the ONE reader of a meeting's analysis, so
// "does this meeting have an analysis" cannot mean two things between the list and the
// detail. Three states collapse into null on purpose: no analyze.json (the meeting was
// saved after its analysis failed), an unreadable one, and one whose stored analysis is
// not a finished 'success' — none of them is something to show.
export async function readStoredAnalysis(
  dir: string,
  id: string,
): Promise<{ analysis: Analysis | null; speakersDegraded: boolean }> {
  try {
    const stored = JSON.parse(
      await fs.readFile(path.join(meetingPath(dir, id), 'analyze.json'), 'utf8'),
    );
    const analysis = stored.analysis as Record<string, unknown> | undefined;
    return {
      analysis: analysis?.status === 'success' && typeof analysis.markdown === 'string'
        ? analysis as unknown as Analysis
        : null,
      speakersDegraded: stored.speakersDegraded ?? false,
    };
  } catch {
    return { analysis: null, speakersDegraded: false };
  }
}

export async function overwriteAnalysis(
  dir: string,
  id: string,
  analysis: Analysis,
): Promise<void> {
  const analyzePath = path.join(meetingPath(dir, id), 'analyze.json');
  let stored: {
    analysis?: Analysis;
    speakersDegraded?: boolean;
    [key: string]: unknown;
  } = {};
  try {
    stored = JSON.parse(await fs.readFile(analyzePath, 'utf8')) as typeof stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.writeFile(analyzePath, JSON.stringify({ ...stored, analysis }, null, 2), 'utf8');
}

// Where an edit has to land: never the original, always the edited copy. Creates that copy
// on the first edit and reuses it for every later one, so editing twice cannot leave two
// edited folders behind (revertMeetingEdit only knows about meta.editedId).
async function resolveEditTarget(dir: string, openId: string, newId: string): Promise<string> {
  const openMeta = await readMeta(dir, openId);
  if (openMeta.originalId) return openId; // already the edited copy
  if (openMeta.editedId) return openMeta.editedId;
  await createEditedCopy(dir, openId, newId);
  return newId;
}

export async function saveEditedAnalysis(
  dir: string,
  openId: string,
  analysis: Analysis,
  newId: string,
): Promise<string> {
  const targetId = await resolveEditTarget(dir, openId, newId);
  await overwriteAnalysis(dir, targetId, analysis);
  return targetId;
}

// The transcript half of a speaker rename. `text` is regenerated rather than patched: it
// is a *rendering* of the segments (segmentsToTranscriptText merges consecutive turns), so two
// labels renamed to the same person must collapse into one line, which a substitution
// over the old string would never do.
async function overwriteSpeakers(
  dir: string,
  id: string,
  mapping: SpeakerNameMap,
): Promise<void> {
  const transcribePath = path.join(meetingPath(dir, id), 'transcribe.json');
  const stored = JSON.parse(await fs.readFile(transcribePath, 'utf8')) as {
    segments?: Segment[];
    [key: string]: unknown;
  };
  const segments = renameSegmentSpeakers(stored.segments ?? [], mapping);
  await fs.writeFile(
    transcribePath,
    JSON.stringify({ ...stored, segments, text: segmentsToTranscriptText(segments) }, null, 2),
    'utf8',
  );
}

// Assigning real names to diarization labels, through the same edited-copy machinery a
// section edit uses — which is what makes "Yapılan Değişiklikleri Geri Al" undo the naming
// too, for free: revertMeetingEdit deletes the whole copy.
//
// Both files are rewritten, because a transcript saying "Ayşe" under an analysis still
// saying "SPEAKER_01" is worse than either one alone. A missing/failed analysis is not an
// error here — the transcript is still named.
export async function saveSpeakerNames(
  dir: string,
  openId: string,
  mapping: SpeakerNameMap,
  newId: string,
): Promise<string> {
  // No-op guard before resolveEditTarget: an empty mapping must not conjure an edited copy
  // (and with it a "Geri Al" button for an edit that never happened).
  if (Object.keys(mapping).length === 0) return resolveActiveMeetingId(dir, openId);

  const targetId = await resolveEditTarget(dir, openId, newId);
  await overwriteSpeakers(dir, targetId, mapping);

  const analyzePath = path.join(meetingPath(dir, targetId), 'analyze.json');
  try {
    const stored = JSON.parse(await fs.readFile(analyzePath, 'utf8')) as { analysis?: Analysis };
    const analysis = stored.analysis;
    if (analysis?.status === 'success' && typeof analysis.markdown === 'string') {
      await overwriteAnalysis(dir, targetId, {
        ...analysis,
        markdown: renameAnalysisLabels(analysis.markdown, mapping),
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return targetId;
}

export async function renameMeetingPair(dir: string, id: string, newName: string): Promise<void> {
  const meta = await readMeta(dir, id);
  const originalId = meta.originalId ?? id;
  const name = newName.trim();
  if (!name) throw new Error('Toplantı adı boş olamaz.');

  const originalMeta = originalId === id ? meta : await readMeta(dir, originalId);
  await writeMeta(dir, originalId, { ...originalMeta, name });
}

export async function revertMeetingEdit(dir: string, id: string): Promise<string> {
  const originalId = await resolveOriginalMeetingId(dir, id);
  const originalMeta = await readMeta(dir, originalId);
  if (originalMeta.editedId) await deleteMeetingCascade(dir, originalMeta.editedId);
  return originalId;
}

async function removeMeetingDirectory(dir: string, id: string): Promise<void> {
  const targetDir = meetingPath(dir, id);
  await fs.rm(targetDir, { recursive: true, force: true });
}

async function removeEmptyDirectories(dir: string, removeSelf: boolean): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => removeEmptyDirectories(path.join(dir, entry.name), true)),
  );

  if (!removeSelf) return;
  try {
    await fs.rmdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
}

export async function cleanEmptyMeetingDirectories(dir: string): Promise<void> {
  await removeEmptyDirectories(dir, false);
}

export async function deleteMeetingCascade(dir: string, id: string): Promise<void> {
  try {
    const meta = await readMeta(dir, id);
    if (meta.originalId) {
      const originalMeta = await readMeta(dir, meta.originalId);
      if (originalMeta.editedId === id) {
        const { editedId: _editedId, ...remainingMeta } = originalMeta;
        await writeMeta(dir, meta.originalId, remainingMeta);
      }
      await removeMeetingDirectory(dir, id);
      return;
    }

    if (meta.editedId) await removeMeetingDirectory(dir, meta.editedId);
    await removeMeetingDirectory(dir, id);
  } finally {
    await cleanEmptyMeetingDirectories(dir);
  }
}
