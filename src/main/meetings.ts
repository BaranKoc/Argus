// Long-term meeting storage. When a live meeting finishes, the derived transcript and
// analysis are persisted here so a real meeting survives the session — the temp WAV it
// came from is deleted for KVKK (see ipc.ts), but the text/analysis is what the user keeps.
//
// Mirrors temp.ts's dev-vs-packaged split: in dev we use the project's meeting_recordings/
// folder (git-ignored) so runs are easy to inspect; when packaged there is no writable
// project dir, so we fall back to userData/meeting_recordings. Unlike temp/, nothing here
// is auto-deleted — these are the records the user chose to keep.

import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  segmentsToTranscriptText,
  DEFAULT_MEETING_SCOPE,
  type Segment,
  type Analysis,
  type MeetingScope,
} from '../../engine/index.ts';
import { idToDate, stamp } from '../../utility/meeting-id.ts';
import {
  deleteMeetingCascade,
  formatMeetingName,
  readMeta,
  readStoredAnalysis,
  resolveActiveMeetingId,
  resolveOriginalMeetingId,
} from '../../utility/meeting-edits.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// out/main/meetings.js -> project root is two levels up. Used only in dev.
const PROJECT_MEETINGS = path.resolve(SCRIPT_DIR, '..', '..', 'meeting_recordings');

export function meetingsDir(): string {
  return app.isPackaged ? path.join(app.getPath('userData'), 'meeting_recordings') : PROJECT_MEETINGS;
}

export interface MeetingResult {
  segments: Segment[];
  // Optional because a meeting whose analysis failed is still worth keeping: the
  // transcript is the irreplaceable half (the audio is already gone), and reanalysis
  // can produce the analysis later from these very segments.
  analysis?: Analysis;
  speakersDegraded?: boolean;
  meetingScope?: MeetingScope;
}

// Persist one finished meeting into its own timestamped folder. Returns the folder id
// (the stamp folder name), which the renderer uses to open the detail / export.
export async function saveMeeting(result: MeetingResult): Promise<string> {
  const id = stamp();
  const dir = path.join(meetingsDir(), id);
  await fs.mkdir(dir, { recursive: true });

  const text = segmentsToTranscriptText(result.segments);
  // meetingScope rides with the transcript, not the analysis: it is a fact about how the
  // recording was made, and reanalysis needs it to render the same text the live run did.
  await fs.writeFile(
    path.join(dir, 'transcribe.json'),
    JSON.stringify(
      { segments: result.segments, text, meetingScope: result.meetingScope ?? DEFAULT_MEETING_SCOPE },
      null,
      2,
    ),
    'utf8',
  );
  // No analysis means no analyze.json at all, rather than a file holding null. That is
  // the shape the read side was already written against — readMeeting, createEditedCopy
  // and saveSpeakerNames all ENOENT-tolerate it as "degraded run" — so an analysis-less
  // meeting travels every existing path without a second representation to handle.
  if (result.analysis) {
    await fs.writeFile(
      path.join(dir, 'analyze.json'),
      JSON.stringify(
        { analysis: result.analysis, speakersDegraded: result.speakersDegraded ?? false },
        null,
        2,
      ),
      'utf8',
    );
  }

  return id;
}

// --- Read side (Dashboard) -------------------------------------------------

export interface MeetingSummary {
  id: string;
  createdAt: string; // ISO
  name: string;
  hasEdited: boolean;
  // 'transcript-only' = the transcript is saved but the analysis is missing, because
  // the provider failed during the live run. The list badges it so the user can see
  // which meetings are waiting for a "Yeniden Analiz", instead of discovering it one
  // meeting at a time in the detail pane.
  status: 'done' | 'transcript-only';
}

export interface MeetingDetail {
  id: string;
  createdAt: string;
  name: string;
  hasEdited: boolean;
  segments: Segment[];
  text: string;
  analysis: Analysis | null;
  speakersDegraded: boolean;
  hasOriginalSpeakers: boolean;
  meetingScope: MeetingScope;
}

// List saved meetings, newest first. Missing/partial folders are skipped rather than
// throwing — a half-written folder must not break the whole list.
export async function listMeetings(): Promise<MeetingSummary[]> {
  const dir = meetingsDir();
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // dir doesn't exist yet — no meetings recorded
  }

  const out: MeetingSummary[] = [];
  for (const id of entries) {
    const date = idToDate(id);
    if (!date) continue; // stray folder that isn't a stamp() id
    // Ignore partial folders so an interrupted write cannot break the whole list.
    try {
      await fs.access(path.join(dir, id, 'transcribe.json'));
    } catch {
      continue;
    }
    const createdAt = date.toISOString();
    const meta = await readMeta(dir, id);
    if (meta.originalId) continue;
    const activeId = await resolveActiveMeetingId(dir, id);
    const { analysis } = await readStoredAnalysis(dir, activeId);
    out.push({
      id,
      createdAt,
      name: meta.name ?? formatMeetingName(createdAt),
      hasEdited: activeId !== id,
      status: analysis ? 'done' : 'transcript-only',
    });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

// Read one meeting's persisted transcript + analysis. Throws if the id is malformed
// or the folder is missing — the caller (ipc) surfaces that as a rejected invoke.
export async function readMeeting(id: string): Promise<MeetingDetail> {
  const rootDir = meetingsDir();
  const originalId = await resolveOriginalMeetingId(rootDir, id);
  const date = idToDate(originalId);
  if (!date) throw new Error(`Geçersiz toplantı kimliği: ${id}`);
  const activeId = await resolveActiveMeetingId(rootDir, originalId);
  const dir = path.join(rootDir, activeId);
  const createdAt = date.toISOString();
  const meta = await readMeta(rootDir, originalId);

  const transcribe = JSON.parse(await fs.readFile(path.join(dir, 'transcribe.json'), 'utf8'));
  const originalTranscribe = activeId === originalId
    ? transcribe
    : JSON.parse(await fs.readFile(path.join(rootDir, originalId, 'transcribe.json'), 'utf8'));
  // analyze.json may be absent for a degraded run; treat that as "no analysis" rather
  // than a hard failure so the transcript still opens.
  const { analysis, speakersDegraded } = await readStoredAnalysis(rootDir, activeId);

  return {
    id: originalId,
    createdAt,
    name: meta.name ?? formatMeetingName(createdAt),
    hasEdited: activeId !== originalId,
    segments: transcribe.segments ?? [],
    text: transcribe.text ?? '',
    analysis,
    speakersDegraded,
    hasOriginalSpeakers: (originalTranscribe.segments ?? []).some((segment: Segment) => Boolean(segment.speaker)),
    // Read from the ORIGINAL, like hasOriginalSpeakers above: how the meeting was recorded
    // cannot be changed by editing it later. Missing on every meeting saved before this
    // option existed, which is exactly what 'group' means.
    meetingScope: readMeetingScope(originalTranscribe),
  };
}

function readMeetingScope(transcribe: unknown): MeetingScope {
  const value = (transcribe as { meetingScope?: unknown } | null)?.meetingScope;
  return value === 'two-party' || value === 'group' ? value : DEFAULT_MEETING_SCOPE;
}

export async function deleteMeeting(id: string): Promise<void> {
  await deleteMeetingCascade(meetingsDir(), id);
}
