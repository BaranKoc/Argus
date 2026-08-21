// Position-based duplicate flagging for the live tail-overlap seam.
//
// Each live round re-decodes the previous round's last tailOverlapSeconds so a word
// split across the boundary isn't lost (chunk-queue.ts), which produces a near-verbatim
// repeat at the seam. Unlike the batch stitch artifact that dedup.ts targets, here we
// know EXACTLY where the seam is — we prepended exactly tailSamples — so the repeat is
// flagged by position instead of re-detected by text/timing heuristics. dedup.ts's
// thresholds miss the live seam anyway: the repeats are mostly short fragments below its
// token floor.
//
// A type-only leaf (like dedup.ts) so it loads no transformers and stays unit-testable
// without audio.

import type { Segment } from '../transcribe/transcriber.ts';

// Small tolerance for Whisper's ~0.02s timestamp jitter, so a repeat that ends a hair
// past the seam still counts as fully inside the tail. Deliberately small: a larger
// value would risk clipping a straddler whose fresh portion is short (see below).
const SEAM_JITTER_SEC = 0.25;

// Fresh audio starts at `seamSec` on the global timeline. A segment that ENDS within
// the re-decoded tail (end <= seamSec) is entirely a re-decode of audio the previous
// round already emitted — a duplicate by construction, whatever its token count. We key
// on `end`, NOT the midpoint: a segment that extends past the seam carries fresh audio,
// and that fresh content can be short (e.g. a partial "Sevkiyatı ayın" completed next
// round to "...25'ine çekebiliriz" — the date lives only in the straddler). A midpoint
// test would flag such a straddler and DROP the new content, which is worse than leaving
// a duplicate. So the bias is: never flag a segment that reaches past the seam; the cost
// is that a pure-repeat straddler stays as a mild (dimmed, LLM-excluded) duplicate.
// Segments without an end timestamp can't be placed and are left untouched. Pure: input
// is not mutated, order preserved.
export function flagSeamDuplicates(segments: Segment[], seamSec: number): Segment[] {
  return segments.map((s) =>
    s.end != null && s.end <= seamSec + SEAM_JITTER_SEC ? { ...s, duplicate: true } : s,
  );
}

// Turkish-aware word tokens (same shape as dedup.ts's tokenize): lowercase, drop
// punctuation, split on whitespace. Kept local so this stays a type-only leaf.
function tokenize(text: string): string[] {
  return text
    .toLocaleLowerCase('tr-TR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// True when [aStart,aEnd] and [bStart,bEnd] share any span — i.e. both segments
// cover some of the same audio, so one is a re-decode of the other, not a distinct
// later utterance that merely happens to start with the same words.
function timeOverlaps(a: Segment, b: Segment): boolean {
  if (a.start == null || a.end == null || b.start == null || b.end == null) return false;
  return a.start < b.end && b.start < a.end;
}

// True when `long`'s leading tokens are exactly `short`'s tokens (short is a strict
// prefix), so `long` is the fuller re-decode of the same opening.
function isStrictPrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || long.length <= short.length) return false;
  for (let k = 0; k < short.length; k++) if (short[k] !== long[k]) return false;
  return true;
}

// Flag forward-orphaned boundary fragments: a truncated segment emitted at the end of
// one round, then subsumed by the NEXT round's tail re-decode that produced the fuller
// version. flagSeamDuplicates can't catch these — it only looks backward within a round
// (the orphan lives in the PRIOR round), and flagDuplicates flags the later repeat, never
// the earlier fragment the longer segment swallowed. Concretely: live S1-C emits
// "Sevkiyatı ayın" [30.5-32.0], and the next round yields "Sevkiyatı ayın 25'ine
// çekebiliriz." [30.51-33.33] — the date lives only in the fuller straddler (kept), while
// the truncated echo lingers and can make the final analysis lose the date.
//
// Conservative by construction — a segment `i` is flagged only when the next
// not-yet-flagged segment `j` (a) time-overlaps it, (b) begins with i's exact tokens as
// a strict prefix, and (c) has more tokens. Prefix (not fuzzy similarity) is what keeps
// genuine near-synonyms like "Ben takip ediyorum." vs "Ben takip ederim." untouched:
// they diverge on the last token, so neither is the other's prefix. Runs over the whole
// assembled transcript at finalize time, after the streaming seam pass. Pure: input is
// not mutated, order preserved.
export function flagBoundaryOrphans(segments: Segment[]): Segment[] {
  const tokens = segments.map((s) => tokenize(s.text));
  const flagged = segments.map((s) => ({ ...s }));

  for (let i = 0; i < flagged.length; i++) {
    if (flagged[i].duplicate) continue;
    // The next segment not already marked duplicate is the candidate fuller re-decode.
    let j = i + 1;
    while (j < flagged.length && flagged[j].duplicate) j++;
    if (j >= flagged.length) continue;

    if (
      timeOverlaps(flagged[i], flagged[j]) &&
      isStrictPrefix(tokens[i], tokens[j])
    ) {
      flagged[i].duplicate = true;
    }
  }

  return flagged;
}
