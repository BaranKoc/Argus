// npm run promote -w engine -- <path-to-a-run-output.json>
//
// Mechanizes the explicit "this run becomes the reference" decision for ONE file the user
// explicitly names. Promotion stays the user's judgement — this tool only does the two
// mechanical parts: COPY the chosen run output into the local control-group/ reference area, and
// rewrite that scenario's row in control-group.md. It never scans for "the newest" or picks
// a file itself.
//
// COPY, not move: the original run under output/ stays as history; prune-test-run can clean
// superseded runs later on an explicit go.

import fs from 'node:fs';
import path from 'node:path';

import {
  CONTROL_GROUP_DIR,
  CONTROL_GROUP_MD,
  OUTPUT_DIR,
  ROOT,
} from './matrix.ts';
import type { ControlGroupKind, RecordingType } from './control-group.ts';

// `<configId>__<base>.json` — configId and base never contain "__" themselves (same shape
// report.ts relies on). Only used as a fallback when the JSON has no `file` field.
const FILE_RE = /^(.+)__(.+)\.json$/;

// Accept an absolute path, an output/-relative path, or a repo-relative path — whichever the
// user pastes from a summary.md or a shell. First hit that exists on disk wins.
function resolveSource(arg: string): string {
  const candidates = [
    path.resolve(arg),
    path.resolve(OUTPUT_DIR, arg),
    path.resolve(ROOT, arg),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`Bulunamadı: "${arg}" (denenen: ${candidates.map((c) => path.relative(ROOT, c)).join(', ')})`);
}

// A reference is either a transcribe or an analyze output; the run layout encodes which in
// the parent directory name. Anything else is a mistake (e.g. pointing at summary.json).
function kindFromSource(srcPath: string, data: Record<string, unknown>): ControlGroupKind {
  if (data.outputType === 'transcribe' || data.outputType === 'analyze') return data.outputType;
  const parent = path.basename(path.dirname(srcPath));
  if (parent === 'transcribe' || parent === 'analyze') return parent;
  throw new Error(`Üst klasör "${parent}" — transcribe/ veya analyze/ altındaki bir çıktı olmalı.`);
}

function recordingTypeFromSource(data: Record<string, unknown>): RecordingType {
  return data.recordingType === 'live' ? 'live' : 'static';
}

// Scenario name: trust the JSON's own `file` field; fall back to the filename convention.
function baseFromFile(srcPath: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    if (typeof data.file === 'string' && data.file.trim()) return data.file.trim();
  } catch {
    // fall through to the filename
  }
  const m = FILE_RE.exec(path.basename(srcPath));
  if (m) return m[2];
  throw new Error(`Senaryo adı çıkarılamadı: ${path.basename(srcPath)} ("file" alanı yok, ad da <config>__<base>.json değil).`);
}

// Keep EXACTLY one reference file per (scenario, kind): drop any prior *__<base>.json in the
// destination dir, even one with a different configId prefix, before copying the new one in.
function clearExisting(destDir: string, base: string): string[] {
  if (!fs.existsSync(destDir)) return [];
  const removed: string[] = [];
  for (const name of fs.readdirSync(destDir)) {
    if (name.endsWith(`__${base}.json`) || name.startsWith(`${base}_`)) {
      fs.rmSync(path.join(destDir, name));
      removed.push(name);
    }
  }
  return removed;
}

// Rewrite the scenario's row in control-group.md. Line-based so the human-authored prose and
// table layout survive untouched. Rows are `| base | transcribe | analyze |`; cell values are
// control-group/-relative with forward slashes (the file is shared across machines now).
function updateRegistry(base: string, kind: ControlGroupKind, recordingType: RecordingType, cellValue: string): void {
  const raw = fs.readFileSync(CONTROL_GROUP_MD, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const isDataRow = (cells: string[]): boolean => {
    const first = cells[0];
    if (!first) return false;
    if (/^:?-{3,}:?$/.test(first)) return false; // |---| separator
    if (first.toLowerCase() === 'dosya') return false; // header
    return true;
  };
  const parseCells = (line: string): string[] =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const buildRow = (cells: [string, string, string, string, string]): string =>
    `| ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cells[3]} | ${cells[4]} |`;

  let lastDataIdx = -1;
  let updated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const cells = parseCells(line);
    if (!isDataRow(cells)) continue;
    lastDataIdx = i;
    if (cells[0] !== base) continue;

    const transcribe = cells[1] && cells[1] !== '-' ? cells[1] : '-';
    const analyze = cells[2] && cells[2] !== '-' ? cells[2] : '-';
    const liveTranscribe = cells[3] && cells[3] !== '-' ? cells[3] : '-';
    const liveAnalyze = cells[4] && cells[4] !== '-' ? cells[4] : '-';
    const next: [string, string, string, string, string] = recordingType === 'live'
      ? kind === 'transcribe' ? [base, transcribe, analyze, cellValue, liveAnalyze] : [base, transcribe, analyze, liveTranscribe, cellValue]
      : kind === 'transcribe' ? [base, cellValue, analyze, liveTranscribe, liveAnalyze] : [base, transcribe, cellValue, liveTranscribe, liveAnalyze];
    lines[i] = buildRow(next);
    updated = true;
    break;
  }

  if (!updated) {
    const row = buildRow(recordingType === 'live'
      ? kind === 'transcribe' ? [base, '-', '-', cellValue, '-'] : [base, '-', '-', '-', cellValue]
      : kind === 'transcribe' ? [base, cellValue, '-', '-', '-'] : [base, '-', cellValue, '-', '-']);
    if (lastDataIdx < 0) throw new Error('control-group.md içinde tablo bulunamadı — el ile bir satır ekleyip tekrar dene.');
    lines.splice(lastDataIdx + 1, 0, row);
  }

  fs.writeFileSync(CONTROL_GROUP_MD, lines.join(eol), 'utf8');
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Kullanım: npm run promote -w engine -- <output/…/{transcribe,analyze}/<config>__<base>.json>');
    process.exit(1);
  }

  const srcPath = resolveSource(arg);
  const data = JSON.parse(fs.readFileSync(srcPath, 'utf8')) as Record<string, unknown>;
  const kind = kindFromSource(srcPath, data);
  const recordingType = recordingTypeFromSource(data);
  const base = baseFromFile(srcPath);
  const fileName = path.basename(srcPath);

  // Live references get their own subtree (live/transcribe, live/analyze) so a live
  // transcribe promote never collides with — and clearExisting never deletes — the
  // live analyze reference for the same base, and vice versa.
  const destDir = recordingType === 'live'
    ? path.join(CONTROL_GROUP_DIR, 'live', kind)
    : path.join(CONTROL_GROUP_DIR, kind);
  const destPath = path.join(destDir, fileName);
  const cellValue = recordingType === 'live' ? `live/${kind}/${fileName}` : `${kind}/${fileName}`; // control-group/-relative, forward slashes

  const removed = clearExisting(destDir, base);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  updateRegistry(base, kind, recordingType, cellValue);

  console.log(`Promote: ${base} / ${recordingType}-${kind}`);
  console.log(`  kaynak : ${path.relative(ROOT, srcPath)}`);
  console.log(`  hedef  : ${path.relative(ROOT, destPath)}`);
  for (const name of removed.filter((n) => n !== fileName)) {
    console.log(`  eski referans silindi: ${path.relative(CONTROL_GROUP_DIR, path.join(destDir, name)).replace(/\\/g, '/')}`);
  }
  console.log(`  control-group.md → "${base}" satırının ${recordingType === 'live' ? 'live ' : ''}${kind} hücresi = ${cellValue}`);
}

main();
