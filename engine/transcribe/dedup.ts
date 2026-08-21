// Chunk-boundary duplicate detection for Whisper's chunked long-form output.
//
// In chunked mode (transcriber.ts) Transformers.js decodes 30s windows with a 5s
// stride overlap and stitches them by merging tokens in the overlap. When Whisper
// repeats itself near a boundary, that merge can emit the *same sentence twice* —
// e.g. S3-F.json's 24.5-25.26 segment, only 0.76s long yet carrying a full sentence
// that just repeats the previous one. No human says that many words that fast.
//
// flagDuplicates() marks such segments with `duplicate: true` (it never removes
// them — the caller keeps them for auditability and only drops them from the joined
// LLM text). Detection is deterministic and text/timing-based, so it is unit-testable
// without audio. Two independent pieces of evidence:
//   1. Text repeat  — most of this segment's words appear as one contiguous run in
//      the immediately preceding segment(s).
//   2. Timing       — the text is far too long to have been spoken in the segment's
//      duration (chars-per-second well above natural speech).
// A near-total text repeat is enough on its own; a partial repeat needs the timing
// evidence too. Short segments (natural "Evet.", "Tamam tamam") are never flagged.

import type { Segment } from './transcriber.ts';

// A segment whose words are >= this fraction contained (as a contiguous run) in the
// preceding text is a duplicate on text alone, regardless of timing.
const STRONG_REPEAT_RATIO = 0.8;
// Below that, a repeat this strong still counts as a duplicate IF the timing is
// implausible too (both pieces of evidence required).
const WEAK_REPEAT_RATIO = 0.6;
// Natural speech is ~12-15 chars/sec; above this a segment can't fit its own text
// in its duration, so the text is a stitched-in repeat rather than really spoken.
const IMPLAUSIBLE_CPS = 25;
// Don't flag tiny segments — repeated short affirmations ("Evet.", "Tamam.") are
// legitimate speech, and the stitch artifact is always a long repeated span.
const MIN_TOKENS = 4;
// How many preceding segments to search for the repeat (the artifact repeats the
// tail of the previous chunk, occasionally spanning two emitted segments).
const LOOKBACK = 2;

// Lowercase (Turkish-aware), drop punctuation, split into word tokens. Empty in -> [].
function tokenize(text: string): string[] {
  return text
    .toLocaleLowerCase('tr-TR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Length (in tokens) of the longest run of tokens common to both arrays, contiguous
// in each. Classic longest-common-substring DP; arrays here are short (one segment).
function longestCommonRun(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0; // dp[i-1][j-1]
    for (let j = 1; j <= b.length; j++) {
      const here = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      diagonal = prev[j];
      prev[j] = here;
      if (here > best) best = here;
    }
  }
  return best;
}

// Chars-per-second for a segment, or null when it has no usable duration (short-clip
// fallback leaves start/end null, and a zero-length span can't tell us anything).
function charsPerSecond(seg: Segment): number | null {
  if (seg.start == null || seg.end == null) return null;
  const dur = seg.end - seg.start;
  if (dur <= 0) return null;
  return seg.text.trim().length / dur;
}

// Return a new Segment[] with `duplicate: true` set on chunk-boundary repeats.
// Pure: input is not mutated. Order is preserved.
export function flagDuplicates(segments: Segment[]): Segment[] {
  const tokens = segments.map((s) => tokenize(s.text));

  return segments.map((seg, i) => {
    const cur = tokens[i];
    if (i === 0 || cur.length < MIN_TOKENS) return seg;

    // Longest contiguous run of this segment's words found in the preceding window.
    const prevWindow: string[] = [];
    for (let k = Math.max(0, i - LOOKBACK); k < i; k++) prevWindow.push(...tokens[k]);
    const runRatio = longestCommonRun(cur, prevWindow) / cur.length;

    const cps = charsPerSecond(seg);
    const implausibleTiming = cps != null && cps > IMPLAUSIBLE_CPS;

    const isDuplicate =
      runRatio >= STRONG_REPEAT_RATIO || (runRatio >= WEAK_REPEAT_RATIO && implausibleTiming);

    return isDuplicate ? { ...seg, duplicate: true } : seg;
  });
}
