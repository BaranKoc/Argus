// Domain-dictionary correction pass: fixes Whisper's clean, non-real-word
// misspellings of domain-specific Turkish business jargon (e.g. "fre" -> "fire") before
// dedup runs, so repeat-matching in dedup.ts also sees the corrected spelling.
//
// Deliberately conservative: the dictionary only carries exact, unambiguous
// misspellings actually observed in the control group, not phonetic guesses or
// near-homophones of real Turkish words — a wrong substitution would corrupt
// legitimate text, which is worse than leaving a miss alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Segment } from './transcriber.ts';
import { getConfig } from '../models.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DICTIONARY_PATH = path.join(SCRIPT_DIR, 'domain-dictionary.json');

// Lazy + cached, mirroring getAsr() in transcriber.ts: read once, reuse. Missing
// or malformed JSON degrades to an empty dictionary (silent no-op) rather than
// throwing, since correction is an optional layer, not a hard dependency.
let dictionary: Record<string, string> | null = null;
let regex: RegExp | null = null;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadDictionary(): Record<string, string> {
  if (dictionary) return dictionary;
  try {
    const raw = fs.readFileSync(DICTIONARY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    dictionary = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    dictionary = {};
  }
  return dictionary;
}

// One combined alternation regex over every key, longest first so a longer key
// (e.g. a multi-word phrase) is never shadowed by a shorter one it contains.
// \b is ASCII-only and breaks on Turkish letters (ç/ş/ğ/ı/ö/ü), so boundaries are
// hand-rolled with Unicode lookarounds instead.
function getRegex(): RegExp | null {
  if (regex) return regex;
  const keys = Object.keys(loadDictionary()).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return null;
  const alternation = keys.map((k) => escapeRegExp(k)).join('|');
  regex = new RegExp(`(?<![\\p{L}\\p{N}])(${alternation})(?![\\p{L}\\p{N}])`, 'giu');
  return regex;
}

function capitalize(word: string): string {
  if (word.length === 0) return word;
  return word[0].toLocaleUpperCase('tr-TR') + word.slice(1);
}

function correctText(text: string): string {
  const re = getRegex();
  if (!re) return text;
  const dict = loadDictionary();
  return text.replace(re, (match) => {
    const canonical = dict[match.toLocaleLowerCase('tr-TR')];
    if (canonical == null) return match;
    const startsUpper = match[0] !== match[0].toLocaleLowerCase('tr-TR');
    return startsUpper ? capitalize(canonical) : canonical;
  });
}

// Return a new Segment[] with domain-term misspellings corrected. Pure: input is
// not mutated, and only `text` changes — start/end/speaker/duplicate pass through.
export function correctSegments(segments: Segment[]): Segment[] {
  if (getConfig().dictionary === false) return segments;
  return segments.map((seg) => ({ ...seg, text: correctText(seg.text) }));
}
