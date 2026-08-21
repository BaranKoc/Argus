// The control-group registry: which output on disk is the reference for each scenario.
//
// WHY A HAND-EDITED FILE INSTEAD OF A DIRECTORY SCAN: filename conventions can change without
// making the newest output the trusted one. Inferring a reference would turn a naming mismatch
// into silent `wer: null` results. A reference is a JUDGEMENT ("this run is the one we trust"),
// so it is written down, not derived. Rows are re-pointed one at a time.
//
// Rows point at files under control-group/ — the local reference area that a promoted run is
// copied into (see promote.ts). The registry is tracked; real reference JSONs are deliberately
// ignored. Paths are resolved relative to that folder, with the same JSON schema
// ({ config, file, metrics, text, segments }) a run produces.

import fs from 'node:fs';
import path from 'node:path';

import { CONTROL_GROUP_DIR, CONTROL_GROUP_MD, ROOT } from './matrix.ts';

export type ControlGroupKind = 'transcribe' | 'analyze';
export type RecordingType = 'static' | 'live';

export interface ControlGroupEntry {
  transcribe?: string;
  analyze?: string;
  liveTranscribe?: string;
  liveAnalyze?: string;
}

// A cell that means "no reference yet". The bootstrap writes '-' before a scenario has
// been run, and an empty cell is what a half-filled row looks like.
function isEmptyCell(cell: string): boolean {
  return cell.length === 0 || cell === '-' || cell === '—';
}

// Parse the markdown table in control-group/control-group.md. Deliberately dumb: any line that
// starts with '|' and whose first cell isn't a header/separator is a row. Prose around
// the table is ignored, so the file stays a document a human actually reads.
// A missing file yields an empty Map rather than throwing — a fresh clone has no
// references yet, and that must degrade to "wer: null", not a crash.
export function parseControlGroup(): Map<string, ControlGroupEntry> {
  const out = new Map<string, ControlGroupEntry>();
  let raw: string;
  try {
    raw = fs.readFileSync(CONTROL_GROUP_MD, 'utf8');
  } catch {
    return out;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const [file, transcribe = '', analyze = '', liveTranscribe = '', liveAnalyze = ''] = cells;
    if (!file) continue;
    if (/^:?-{3,}:?$/.test(file)) continue; // |---| separator
    if (file.toLowerCase() === 'dosya') continue; // header
    const entry: ControlGroupEntry = {};
    if (!isEmptyCell(transcribe)) entry.transcribe = transcribe;
    if (!isEmptyCell(analyze)) entry.analyze = analyze;
    if (!isEmptyCell(liveTranscribe)) entry.liveTranscribe = liveTranscribe;
    if (!isEmptyCell(liveAnalyze)) entry.liveAnalyze = liveAnalyze;
    out.set(file, entry);
  }
  return out;
}

// Absolute path of a scenario's reference output, or null if the registry has no row /
// no cell for it. Throws on a path that escapes control-group/ — the registry is
// hand-edited (and promote.ts writes it), so a typo'd '../..' should surface as an error,
// not silently read outside the tracked reference tree.
function entryKey(kind: ControlGroupKind, recordingType: RecordingType): keyof ControlGroupEntry {
  if (recordingType === 'static') return kind;
  return kind === 'transcribe' ? 'liveTranscribe' : 'liveAnalyze';
}

export function resolveControlGroup(
  base: string,
  kind: ControlGroupKind,
  recordingType: RecordingType = 'static',
): string | null {
  const rel = parseControlGroup().get(base)?.[entryKey(kind, recordingType)];
  if (!rel) return null;
  const abs = path.resolve(CONTROL_GROUP_DIR, rel);
  if (path.relative(CONTROL_GROUP_DIR, abs).startsWith('..')) {
    throw new Error(`control-group.md: "${rel}" control-group/ dışına çıkıyor (${base}/${kind}).`);
  }
  return abs;
}

// The reference transcript text for a scenario, for the WER/hallucination metrics.
// Returns null when there is no reference or it can't be read — bench reports those
// metrics as null and carries on, since a scenario being new is not a bench failure.
//
// `path` is repo-relative with forward slashes, NOT the absolute path we just read from.
// It gets persisted verbatim into every output JSON as metrics.referencePath, and this
// project has already been renamed and moved twice — absolute paths baked in by earlier
// checkouts still sit in old references, pointing at directories that no longer exist.
// Only buildMetrics consumes this field, so the read itself keeps the absolute path.
export function controlGroupText(
  base: string,
  recordingType: RecordingType = 'static',
): { path: string; text: string } | null {
  const p = resolveControlGroup(base, 'transcribe', recordingType);
  if (!p) return null;
  try {
    const text = JSON.parse(fs.readFileSync(p, 'utf8')).text ?? '';
    return { path: path.relative(ROOT, p).split(path.sep).join('/'), text };
  } catch {
    return null;
  }
}
