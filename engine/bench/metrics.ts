// Benchmark metrics — pure functions over transcripts + segments, so they unit-test
// without a model. The reference for divergence/hallucination is the control-group
// output named in control-group/control-group.md (control-group.ts), NOT a hand-authored
// ground truth — see docs/model-selection.md. So "WER" here is divergence FROM
// that reference; domain-term recall (absolute checklist) is the real accuracy signal,
// and a human still eyeballs the diffs.
//
// The reference and term list are passed IN (see buildMetrics) rather than read here, so
// this module never touches the filesystem and stays trivially testable.

import type { Segment } from '../transcribe/transcriber.ts';

// --- Turkish-aware text normalization ---------------------------------------
// The point: "3 konu" must equal "üç konu" and "yüzde 7" must equal "%7", so that a
// model spelling a number differently doesn't register as divergence. But "%70" is a
// REAL error vs "yüzde 7" and stays distinct — value is preserved, never hidden.

const NUMWORD: Record<string, number> = {
  sıfır: 0, bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9,
  on: 10, yirmi: 20, otuz: 30, kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90,
  yüz: 100, bin: 1000,
};

// Evaluate a run of consecutive Turkish number words to a single integer.
// Handles units, tens, "yüz" (×100) and "bin" (×1000): "yirmi beş"->25, "yüz elli"->150.
function evalNumberRun(words: string[]): number {
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w === 'yüz') current = (current || 1) * 100;
    else if (w === 'bin') {
      total += (current || 1) * 1000;
      current = 0;
    } else current += NUMWORD[w];
  }
  return total + current;
}

// Fold maximal runs of number-word tokens into one digit token; leave everything else.
function foldNumberWords(tokens: string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length) out.push(String(evalNumberRun(run)));
    run = [];
  };
  for (const t of tokens) {
    if (Object.prototype.hasOwnProperty.call(NUMWORD, t)) run.push(t);
    else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

// Merge "yüzde 7" / "% 7" into a single "%7" token (value preserved).
function foldPercent(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === 'yüzde' || t === '%') && /^\d+$/.test(tokens[i + 1] ?? '')) {
      out.push(`%${tokens[i + 1]}`);
      i++;
    } else out.push(t);
  }
  return out;
}

// Full normalization -> array of comparable tokens.
export function normalizeTokens(text: string): string[] {
  let s = text.toLocaleLowerCase('tr-TR');
  // Keep letters, digits, %, and digit separators; everything else -> space.
  s = s.replace(/[^\p{L}\p{N}%.,\s]/gu, ' ');
  // Flatten digit-internal separators consistently: "3.500"->"3500", "12,5"->"125"
  // (two passes cover grouped numbers like "1.200.000"). Consistency matters more than
  // exact value here — both sides get the same treatment.
  s = s.replace(/(\d)[.,](\d)/g, '$1$2').replace(/(\d)[.,](\d)/g, '$1$2');
  s = s.replace(/[.,]/g, ' '); // remaining separators = sentence punctuation
  let tokens = s.split(/\s+/).filter(Boolean);
  tokens = foldNumberWords(tokens);
  tokens = foldPercent(tokens);
  return tokens;
}

export function normalizeText(text: string): string {
  return normalizeTokens(text).join(' ');
}

// --- Word error / divergence rate -------------------------------------------
// Token-level Levenshtein distance / reference length. With the control-group
// reference this is "divergence from the medium baseline", not accuracy.
function editDistance(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr.slice();
  }
  return prev[n];
}

export interface WerResult {
  wer: number; // distance / reference tokens
  distance: number;
  refTokens: number;
  hypTokens: number;
}

// hyp = this run's text, ref = control-group baseline text.
export function wer(hyp: string, ref: string): WerResult {
  const h = normalizeTokens(hyp);
  const r = normalizeTokens(ref);
  const distance = editDistance(h, r);
  return {
    wer: r.length === 0 ? (h.length === 0 ? 0 : 1) : distance / r.length,
    distance,
    refTokens: r.length,
    hypTokens: h.length,
  };
}

// --- Domain-term recall (the real accuracy signal) --------------------------
// For each expected term, is it present (normalized substring). A corrupted term
// (boyahane->boyaniye) simply isn't found — that's the signal we want. Turbo is
// expected to WIN here (analysis §4: brief/deadline/domain words degrade on medium).

export interface DomainRecall {
  terms: { term: string; present: boolean }[];
  found: number;
  total: number;
  recall: number;
}

export function domainRecall(text: string, terms: string[]): DomainRecall {
  const hay = normalizeText(text);
  const result = terms.map((term) => ({
    term,
    present: hay.includes(normalizeText(term)),
  }));
  const found = result.filter((t) => t.present).length;
  return { terms: result, found, total: terms.length, recall: terms.length ? found / terms.length : 1 };
}

// --- Timestamp quality + flag counts (S3 regression guard) ------------------
// Medium's timestamps stuck to integers after ~28s (analysis). A model whose bounds
// collapse to integers can starve flagDuplicates' duration check, so we report the
// decimal ratio. flagDuplicates/assignSpeakers already ran inside transcribe(); we
// just count the flags they set — S3-F must have exactly 1 duplicate.

export interface TimestampQuality {
  boundaries: number;
  decimal: number;
  integerStuck: number;
  decimalRatio: number;
}

export function timestampQuality(segments: Segment[]): TimestampQuality {
  const bounds: number[] = [];
  for (const s of segments) {
    if (s.start != null) bounds.push(s.start);
    if (s.end != null) bounds.push(s.end);
  }
  const decimal = bounds.filter((b) => !Number.isInteger(b)).length;
  const integerStuck = bounds.length - decimal;
  return {
    boundaries: bounds.length,
    decimal,
    integerStuck,
    decimalRatio: bounds.length ? decimal / bounds.length : 0,
  };
}

export function flagCounts(segments: Segment[]): { duplicate: number; overlap: number } {
  return {
    duplicate: segments.filter((s) => s.duplicate).length,
    overlap: segments.filter((s) => s.overlap).length,
  };
}

// Rough hallucination proxy: sentences in the run that don't appear (normalized) in the
// reference. Coarse — sentence-splitting on Turkish is imperfect — so it's a signal to
// eyeball, not a verdict. Reported alongside the duplicate-flag count.
export function hallucinationCount(hyp: string, ref: string): number {
  const refNorm = normalizeText(ref);
  const sentences = hyp
    .split(/[.!?]+/)
    .map((s) => normalizeText(s))
    .filter((s) => s.split(' ').filter(Boolean).length >= 3); // ignore fragments
  return sentences.filter((s) => !refNorm.includes(s)).length;
}

// --- The metric block written into every output JSON ------------------------
// Shared by bench/run.ts and the manual test-run tool so a single-file manual run and a
// full bench row are the same measurement — that's what lets control-group.md point at
// either one. `ref` null (scenario has no reference yet) => the reference-relative
// metrics are null rather than 0: "unknown" must not read as "perfect".

const MB = 1024 * 1024;

export interface MetricsInput {
  text: string;
  segments: Segment[];
  durationSec?: number;
  ms?: number;
  loadMs: number;
  peakRss: number;
  diskBytes: number;
}

// S3-F exists to prove flagDuplicates still catches the chunk-boundary repeat. Exactly one
// duplicate flag is the pass condition, so the console calls it out instead of burying it
// in the JSON — a silent 0 here is the regression we most care about.
const DEDUP_GUARD_FILE = 'S3-F';

export function formatMetricLine(file: string, m: Record<string, unknown>): string {
  const dr = m.domainRecall as DomainRecall;
  const rtf = m.rtf as number | null;
  const parts = [
    `wer=${m.wer ?? 'n/a'}`,
    `recall=${dr.found}/${dr.total}`,
    `rtf=${rtf?.toFixed(2) ?? 'n/a'}`,
  ];
  if (file === DEDUP_GUARD_FILE) {
    const dup = m.duplicateFlags as number;
    parts.push(`duplicate=${dup}${dup === 1 ? ' ✓' : ' ⚠ (S3 regresyon!)'}`);
  }
  return parts.join(' ');
}

export const METRICS_TABLE_HEADER = [
  '| config | dosya | wer↓ | domain recall↑ | dup | overlap | halüs. | rtf↓ | RSS(MB) | disk(MB) |',
  '|---|---|---|---|---|---|---|---|---|---|',
];

export function metricsTableRow(id: string, file: string, m: Record<string, unknown>): string {
  const dr = m.domainRecall as DomainRecall;
  const rtf = m.rtf as number | null;
  return `| ${id} | ${file} | ${m.wer ?? 'n/a'} | ${dr.found}/${dr.total} | ${m.duplicateFlags} | ${m.overlapFlags} | ${m.hallucinationSentences ?? 'n/a'} | ${rtf?.toFixed(2) ?? 'n/a'} | ${m.peakRssMB} | ${m.diskMB} |`;
}

export function buildMetrics(
  input: MetricsInput,
  ref: { path: string; text: string } | null,
  terms: string[],
): Record<string, unknown> {
  const werRes = ref ? wer(input.text, ref.text) : null;
  const flags = flagCounts(input.segments);
  return {
    rtf: input.durationSec && input.ms ? input.ms / 1000 / input.durationSec : null,
    transcribeMs: input.ms != null ? Math.round(input.ms) : null,
    audioSec: input.durationSec ?? null,
    loadMs: Math.round(input.loadMs),
    peakRssMB: +(input.peakRss / MB).toFixed(1),
    diskMB: +(input.diskBytes / MB).toFixed(1),
    wer: werRes ? +werRes.wer.toFixed(4) : null,
    werRefTokens: werRes?.refTokens ?? null,
    referencePath: ref?.path ?? null,
    domainRecall: domainRecall(input.text, terms),
    duplicateFlags: flags.duplicate,
    overlapFlags: flags.overlap,
    hallucinationSentences: ref ? hallucinationCount(input.text, ref.text) : null,
    timestamps: timestampQuality(input.segments),
  };
}
