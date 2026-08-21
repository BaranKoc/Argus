import fs from 'node:fs/promises';
import path from 'node:path';
import {
  analyze,
  segmentsToSideDialogue,
  type Analysis,
  type MeetingScope,
  type Transcript,
} from '../../engine/index.ts';
import {
  overwriteAnalysis,
  resolveOriginalMeetingId,
  revertMeetingEdit,
} from '../../utility/meeting-edits.ts';

export type AnalyzeMeeting = (transcript: string | Transcript) => Promise<Analysis>;

export interface ReanalysisOptions {
  includeSpeakers: boolean;
  // Not a user choice here, unlike includeSpeakers: it is read off the stored recording so
  // a reanalysis renders the same text the live run analysed. Absent for a meeting saved
  // before the option existed, which means 'group'.
  meetingScope?: MeetingScope;
}

// A two-party meeting is analysed from the capture sides, so it hands `analyze` finished
// TEXT rather than a Transcript — analyze() renders a Transcript with segmentsToDialogue,
// which drops the sides on purpose (see dialogue.ts). Everything else keeps the existing
// Transcript path, where includeSpeakers decides whether the labels survive.
export function prepareTranscriptForReanalysis(
  segments: Transcript['segments'],
  options: ReanalysisOptions,
): string | Transcript {
  if (options.meetingScope === 'two-party') return segmentsToSideDialogue(segments);
  if (options.includeSpeakers) return { status: 'success', segments };
  return {
    status: 'success',
    segments: segments.map(({ speaker: _speaker, ...segment }) => segment),
  };
}

export async function reanalyzeMeetingAnalysis(
  dir: string,
  id: string,
  options: ReanalysisOptions,
  runAnalysis: AnalyzeMeeting = analyze,
): Promise<string> {
  const originalId = await resolveOriginalMeetingId(dir, id);
  const stored = JSON.parse(
    await fs.readFile(path.join(dir, originalId, 'transcribe.json'), 'utf8'),
  ) as { segments?: Transcript['segments']; meetingScope?: MeetingScope };
  // Taken from the recording, never from the caller: the renderer's reanalysis dialog asks
  // about speakers, and how many parties were in the room is not something it can revise.
  const transcript = prepareTranscriptForReanalysis(stored.segments ?? [], {
    ...options,
    meetingScope: stored.meetingScope,
  });

  const analysis = await runAnalysis(transcript);
  await overwriteAnalysis(dir, originalId, analysis);
  await revertMeetingEdit(dir, originalId);
  return originalId;
}

export class MeetingReanalysisCoordinator {
  readonly #running = new Map<string, Promise<string>>();

  async run(
    dir: string,
    id: string,
    options: ReanalysisOptions,
    runAnalysis: AnalyzeMeeting = analyze,
  ): Promise<string> {
    const originalId = await resolveOriginalMeetingId(dir, id);
    if (this.#running.has(originalId)) {
      throw new Error('Bu toplantı için yeniden analiz zaten devam ediyor.');
    }

    const pending = reanalyzeMeetingAnalysis(dir, originalId, options, runAnalysis);
    this.#running.set(originalId, pending);
    try {
      return await pending;
    } finally {
      this.#running.delete(originalId);
    }
  }
}
