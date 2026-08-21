// Renaming diarization labels ("SPEAKER_01") to real names, and the read side that lets
// the user decide what each label should become. Pure string/array work with no node
// imports, because both sides need it: the renderer builds the naming panel from these,
// the main process writes the result to disk (meeting-edits.ts saveSpeakerNames).

import { ANALYSIS_SECTIONS, type AnalysisDraft } from '../engine/analyze/sections.ts';
import type { Segment } from '../engine/transcribe/transcriber.ts';

// old label -> new name. Only the labels the user actually changed are present.
export type SpeakerNameMap = Record<string, string>;

// The labels the naming panel offers, in first-appearance order — "SPEAKER_00 = whoever
// spoke first" is the only reading order that lets a listener recognise anyone.
export function speakerLabels(segments: Segment[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const segment of segments) {
    const label = segment.speaker;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

// Which capture side a speaker was on, for the naming panel: knowing "this one was on the
// call" is often the whole clue needed to put a name to a label. Attribution already made
// a speaker's segments agree (source-attribution.ts votes per speaker), so the first
// attributed segment answers for all of them.
export function speakerSource(segments: Segment[], label: string): Segment['source'] {
  return segments.find((segment) => segment.speaker === label && segment.source)?.source;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ONE alternation over all labels, longest first, applied in a single pass. Longest-first
// is what keeps "SPEAKER_1" from eating the front of "SPEAKER_10"; the single pass is what
// makes a chain impossible — a name written by this replacement is never re-examined, so
// mapping {A: B, B: C} can never turn an A into a C.
function labelPattern(labels: string[]): RegExp {
  const alternatives = [...labels]
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegExp)
    .join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, 'gu');
}

export function renameSegmentSpeakers(segments: Segment[], mapping: SpeakerNameMap): Segment[] {
  return segments.map((segment) => {
    const next = segment.speaker ? mapping[segment.speaker] : undefined;
    return next ? { ...segment, speaker: next } : segment;
  });
}

// The analysis refers to speakers by the same label the dialogue used ("- SPEAKER_01: Saat
// on bire kadar…"), so renaming there is a text substitution over the stored markdown —
// no parse/reserialize round trip, which would risk reshaping items we never touched.
export function renameAnalysisLabels(markdown: string, mapping: SpeakerNameMap): string {
  const labels = Object.keys(mapping);
  if (labels.length === 0) return markdown;
  return markdown.replace(labelPattern(labels), (match) => mapping[match] ?? match);
}

export interface SpeakerAnalysisMention {
  sectionTitle: string;
  item: string;
}

// What this speaker is on record for in the analysis — the left column of the naming
// panel, and the thing that actually lets the user put a name to a label.
export function analysisItemsBySpeaker(
  draft: AnalysisDraft,
  label: string,
): SpeakerAnalysisMention[] {
  const pattern = labelPattern([label]);
  const out: SpeakerAnalysisMention[] = [];
  for (const section of ANALYSIS_SECTIONS) {
    for (const item of draft[section.key]) {
      pattern.lastIndex = 0;
      if (pattern.test(item)) out.push({ sectionTitle: section.title, item });
    }
  }
  return out;
}

// What this speaker said, for the right column. Duplicate-flagged segments are the
// chunk-boundary stitch repeats the dialogue already drops, so they'd only pad the panel
// with sentences the user reads twice.
export function speakerTranscriptLines(segments: Segment[], label: string): string[] {
  return segments
    .filter((segment) => segment.speaker === label && !segment.duplicate)
    .map((segment) => segment.text.trim())
    .filter(Boolean);
}

const RESERVED_LABEL = /^speaker[ _-]?\d+$/i;

// A name shaped like a diarizer label would be indistinguishable from one, and could
// collide with a label that is still unnamed.
export function isReservedSpeakerName(value: string): boolean {
  return RESERVED_LABEL.test(value.trim());
}

// ':' is the dialogue format's own separator and a newline ends the turn, so either one
// inside a name would make the rendered transcript lie about who said what.
export function speakerNameError(value: string): string | null {
  const name = value.trim();
  if (!name) return null; // empty means "leave this label alone", not an error
  if (/[:\r\n]/.test(name)) return 'İsimde iki nokta veya satır sonu olamaz.';
  if (isReservedSpeakerName(name)) return 'Bu ad bir konuşmacı etiketiyle karışıyor.';
  return null;
}

// Only the labels that actually change: an unchanged or blank field must not reach disk,
// so that "hiçbir şey değiştirmedim" writes nothing at all.
export function buildSpeakerNameMap(entries: { label: string; name: string }[]): SpeakerNameMap {
  const mapping: SpeakerNameMap = {};
  for (const { label, name } of entries) {
    const next = name.trim();
    if (!next || next === label) continue;
    mapping[label] = next;
  }
  return mapping;
}
