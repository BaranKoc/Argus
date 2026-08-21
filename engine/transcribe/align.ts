// Align Whisper text segments with diarization speaker turns — the join step
// WhisperX performs. Whisper gives {start, end, text}; the diarizer gives
// {start, end, speaker}. For each text segment we find the speaker turn it
// overlaps the most in time and attach that speaker, and — as a crosstalk proxy —
// flag `overlap: true` when the segment spans two or more distinct speakers
// meaningfully (a collapsed simultaneous-speech region; see the Segment doc).
//
// This works at Whisper's segment granularity (its own sentence/chunk
// timestamps). It's intentionally coarse for v1: a segment spanning two
// speakers is labelled by whoever dominates it. Moving to word-level alignment
// later means calling this with per-word segments — the overlap logic is the same.

import type { Segment } from './transcriber.ts';
import type { SpeakerSegment } from '../diarize/diarizer.ts';

// A speaker counts toward the `overlap` flag only when it covers BOTH at least this
// many seconds AND this fraction of the segment — enough presence to be real speech,
// not a segment just clipping the edge of a neighbouring turn.
const MIN_OVERLAP_SEC = 0.5;
const MIN_OVERLAP_FRAC = 0.3;

// Seconds of overlap between [aStart,aEnd] and [bStart,bEnd] (0 if disjoint).
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Return a new Segment[] with `speaker` set from the best-overlapping turn and
// `overlap: true` where the segment is meaningfully shared by >=2 speakers.
// Segments without usable timestamps (short-clip fallback where start/end are
// null) are left unlabelled, as are segments that overlap no turn.
export function assignSpeakers(
  segments: Segment[],
  diarization: SpeakerSegment[],
): Segment[] {
  if (diarization.length === 0) return segments;

  return segments.map((seg) => {
    if (seg.start == null || seg.end == null) return seg;
    const segDur = seg.end - seg.start;

    // Total overlap seconds this segment shares with each speaker (a speaker may
    // have several turns), so we can pick the dominant one and count how many
    // speakers are meaningfully present.
    const perSpeaker = new Map<string, number>();
    for (const turn of diarization) {
      const ov = overlap(seg.start, seg.end, turn.start, turn.end);
      if (ov > 0) perSpeaker.set(turn.speaker, (perSpeaker.get(turn.speaker) ?? 0) + ov);
    }

    let best: string | undefined;
    let bestOverlap = 0;
    let meaningfulSpeakers = 0;
    for (const [speaker, ov] of perSpeaker) {
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = speaker;
      }
      if (ov >= MIN_OVERLAP_SEC && (segDur <= 0 || ov >= MIN_OVERLAP_FRAC * segDur)) {
        meaningfulSpeakers++;
      }
    }

    const next: Segment = best ? { ...seg, speaker: best } : { ...seg };
    if (meaningfulSpeakers >= 2) next.overlap = true;
    return next;
  });
}
