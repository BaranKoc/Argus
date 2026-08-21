// Pure Segment[] -> string / Segment[] rendering helpers. Extracted from index.ts
// so both the batch API (index.ts) and the live seam (live/finalize.ts) can share
// them without an import cycle: index.ts re-exports the live session, and finalize.ts
// needs these renderers, so they can't live in index.ts. No logic here depends on the
// engine's orchestration — it's just text-shaping over segments.

import type { Segment } from './transcriber.ts';

// Join timestamped segments into one clean plain-text string (no speakers).
// Duplicate-flagged segments (chunk-boundary stitch repeats) are excluded so the
// repeated sentence never reaches the LLM, while staying in the segments array.
function segmentsToText(segments: Segment[]): string {
  return segments
    .filter((s) => !s.duplicate)
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Turkish, because everything downstream of this string is Turkish: the exported PDF and
// Markdown, and the transcript the user reads.
//
// Two forms, because the side plays two different grammatical roles. Qualifying a known
// speaker it is an aside — "SPEAKER_01 (Uzak)". Standing alone it IS the turn's speaker,
// so the two sides that are a speaking party get named as one. "Karışık" keeps its bare
// form in both: "Karışık Konuşmacı" would name a person who does not exist.
const SOURCE_ASIDE: Record<NonNullable<Segment['source']>, string> = {
  local: 'Yerel',
  remote: 'Uzak',
  mixed: 'Karışık',
};
const SOURCE_AS_SPEAKER: Record<NonNullable<Segment['source']>, string> = {
  local: 'Yerel Konuşmacı',
  remote: 'Uzak Konuşmacı',
  mixed: 'Karışık',
};

// What opens a line. Two independent facts can qualify a turn — who said it and which
// side of the call it came from — and either can be missing:
//
//   SPEAKER_01 (Uzak): …   both known
//   SPEAKER_01: …          diarized, but this turn was too faint to place
//   Uzak Konuşmacı: …      no diarization; the side is all we can honestly say
//
// The speaker label stays a bare leading token in every form, because renaming it is a
// text substitution over this very output (utility/speaker-names.ts).
function turnLabel(segment: Segment, withSpeakers: boolean, withSources: boolean): string {
  const speaker = withSpeakers ? (segment.speaker ?? 'SPEAKER_??') : '';
  if (!withSources) return speaker;
  if (!speaker) return segment.source ? SOURCE_AS_SPEAKER[segment.source] : 'Belirsiz';
  return segment.source ? `${speaker} (${SOURCE_ASIDE[segment.source]})` : speaker;
}

// Render segments as an attributed dialogue, merging consecutive segments that carry the
// same label onto one line. Falls back to plain text when there is nothing to attribute
// with — no speakers and no sources — so every caller still gets clean output.
function renderDialogue(segments: Segment[], withSpeakers: boolean, withSources: boolean): string {
  const hasSpeakers = withSpeakers && segments.some((s) => s.speaker);
  const hasSources = withSources && segments.some((s) => s.source);
  if (!hasSpeakers && !hasSources) return segmentsToText(segments);

  const lines: string[] = [];
  let currentLabel: string | null = null;
  const buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length > 0 && currentLabel) {
      const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(`${currentLabel}: ${text}`);
    }
    buffer.length = 0;
  };

  for (const seg of segments) {
    if (seg.duplicate) continue; // drop chunk-boundary stitch repeats from the dialogue
    const text = seg.text.trim();
    if (!text) continue;
    const label = turnLabel(seg, hasSpeakers, hasSources);
    if (label !== currentLabel) {
      flush();
      currentLabel = label;
    }
    buffer.push(text);
  }
  flush();

  return lines.join('\n');
}

// Speaker-attributed dialogue, no capture side. This is what reaches the LLM (both here
// and through index.ts's analyze()), and it is deliberately unchanged by the local/remote
// work: putting the side into the analysed text would alter every analysis this app
// produces, which is a decision to make against the control group, not a side effect.
export function segmentsToDialogue(segments: Segment[]): string {
  return renderDialogue(segments, true, false);
}

// The transcript as a person reads it — stored with the meeting and exported to
// Markdown/PDF, so it carries the capture side alongside the speaker where one is known.
export function segmentsToTranscriptText(segments: Segment[]): string {
  return renderDialogue(segments, true, true);
}

// The capture side as the speaker, for a meeting the user declared to be two-party. Passes
// withSpeakers: false on purpose — the label must be the bare side and nothing else. Were a
// speaker label to survive on a segment it would render "SPEAKER_01 (Uzak)", which reads as
// a diarized meeting and is exactly what this mode says it is not.
export function segmentsToSideDialogue(segments: Segment[]): string {
  return renderDialogue(segments, false, true);
}

// Which of the three renderings above reaches the LLM.
//
// sidesAsSpeakers is the two-party declaration, and it is the ONE case where the capture
// side is allowed into the analysed text. The general rule stays what segmentsToDialogue
// documents: sides are not speakers, because "Uzak Konuşmacı" covers however many people
// are on the far end. With exactly two parties that count is one, so the objection does not
// apply and the analysis gets attribution it would otherwise have to do without.
export function segmentsToAnalysisText(
  segments: Segment[],
  includeSpeakers: boolean,
  sidesAsSpeakers = false,
): string {
  if (sidesAsSpeakers) return segmentsToSideDialogue(segments);
  return includeSpeakers ? segmentsToDialogue(segments) : segmentsToText(segments);
}
