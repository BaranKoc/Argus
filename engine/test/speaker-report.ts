// Speaker-side reporting for the live-transcribe stage — deliberately separate from
// bench/metrics.ts. Those metrics answer "how far did the text drift from a promoted
// reference"; this file answers "what did blind diarization actually do", which has no
// reference to drift from: every control-group transcript was promoted with diarization
// off, so it carries no speaker labels at all. Keeping the two apart also means the
// speaker test can never accidentally read the control group.

import type { Segment } from '../transcribe/transcriber.ts';

export interface SpeakerShare {
  id: string;
  segments: number;
  seconds: number;
  share: number;
}

export interface SpeakerReport {
  speakerCount: number;
  // Ordered by first appearance, mirroring pyannote-worker.py's relabel(): that is what
  // makes "SPEAKER_00 = whoever spoke first" a readable claim rather than an arbitrary id.
  speakers: SpeakerShare[];
  turns: number;
  switches: number;
  unlabeled: number;
  unlabeledSeconds: number;
  overlapFlags: number;
  labeledSeconds: number;
}

// Ground truth from the scenario scripts in docs/test-materials.md — how many people
// actually speak in the recording. null = unscripted recording, no known count.
export const EXPECTED_SPEAKERS: Record<string, number | null> = {
  'S1-C': 2,
  'S1-F': 2,
  'S2-C': 2,
  'S2-F': 2,
  'S3-F': 2,
  'S4-C': 2,
  'S5-C': 2,
  'S6-C': 2,
  'S7-A': 0,
  'S7-B': 1,
  'S7-C': 1,
  'S7-D': 1,
  'S7-E': 1,
  'S8': null,
};

function durationOf(segment: Segment): number {
  if (segment.start == null || segment.end == null) return 0;
  return Math.max(0, segment.end - segment.start);
}

export function speakerReport(segments: Segment[]): SpeakerReport {
  const byId = new Map<string, { segments: number; seconds: number }>();
  let unlabeled = 0;
  let unlabeledSeconds = 0;
  let overlapFlags = 0;
  let turns = 0;
  let previous: string | null = null;

  for (const segment of segments) {
    if (segment.overlap) overlapFlags += 1;
    const id = segment.speaker;
    if (!id) {
      unlabeled += 1;
      unlabeledSeconds += durationOf(segment);
      // An unlabeled gap does not end a turn — the surrounding labels may well be the
      // same person, and counting it as a switch would inflate churn on exactly the
      // scenarios (S3-F, S6-C) where labels are sparsest.
      continue;
    }
    const entry = byId.get(id) ?? { segments: 0, seconds: 0 };
    entry.segments += 1;
    entry.seconds += durationOf(segment);
    byId.set(id, entry);
    if (id !== previous) turns += 1;
    previous = id;
  }

  const labeledSeconds = [...byId.values()].reduce((sum, e) => sum + e.seconds, 0);
  const speakers: SpeakerShare[] = [...byId.entries()].map(([id, e]) => ({
    id,
    segments: e.segments,
    seconds: +e.seconds.toFixed(1),
    share: labeledSeconds > 0 ? +(e.seconds / labeledSeconds).toFixed(3) : 0,
  }));

  return {
    speakerCount: speakers.length,
    speakers,
    turns,
    switches: Math.max(0, turns - 1),
    unlabeled,
    unlabeledSeconds: +unlabeledSeconds.toFixed(1),
    overlapFlags,
    labeledSeconds: +labeledSeconds.toFixed(1),
  };
}

function clock(seconds: number | null): string {
  if (seconds == null) return '--:--';
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// A plain-text rendering for the human pass. The JSON's `text` field carries the same
// dialogue, but escaped onto one line — unreadable for the eyeball check that is the
// actual verdict on speaker separation.
export function dialogueLines(segments: Segment[]): string {
  return segments
    .map((s) => {
      const flags = [s.duplicate ? 'DUP' : null, s.overlap ? 'OVERLAP' : null].filter(Boolean);
      const suffix = flags.length ? `   [${flags.join(' ')}]` : '';
      return `[${clock(s.start)}-${clock(s.end)}] ${s.speaker ?? 'SPEAKER_??'}: ${s.text.trim()}${suffix}`;
    })
    .join('\n');
}

export const SPEAKER_TABLE_HEADER = [
  '| dosya | beklenen | bulunan | ✓ | turn | switch | etiketsiz | overlap | konuşma payı | süre(s) |',
  '|---|---|---|---|---|---|---|---|---|---|',
];

export function speakerTableRow(file: string, report: SpeakerReport, audioSec: number): string {
  const expected = EXPECTED_SPEAKERS[file];
  const verdict = expected == null ? '—' : report.speakerCount === expected ? '✓' : '⚠';
  const shares = report.speakers.length
    ? report.speakers.map((s) => `${s.id.replace('SPEAKER_', '')}:${(s.share * 100).toFixed(0)}%`).join(' ')
    : '—';
  return `| ${file} | ${expected ?? 'n/a'} | ${report.speakerCount} | ${verdict} | ${report.turns} | ${report.switches} | ${report.unlabeled} | ${report.overlapFlags} | ${shares} | ${audioSec.toFixed(1)} |`;
}

export function formatSpeakerLine(file: string, report: SpeakerReport): string {
  const expected = EXPECTED_SPEAKERS[file];
  const verdict = expected == null ? '(beklenen bilinmiyor)' : report.speakerCount === expected ? '✓' : `⚠ beklenen ${expected}`;
  const shares = report.speakers.map((s) => `${s.id}=${(s.share * 100).toFixed(0)}%/${s.seconds}s`).join('  ');
  return `konuşmacı=${report.speakerCount} ${verdict}  turn=${report.turns}  etiketsiz=${report.unlabeled}  overlap=${report.overlapFlags}\n    ${shares}`;
}
