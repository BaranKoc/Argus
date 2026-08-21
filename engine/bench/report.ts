// Static HTML report generator — the missing "read it back" half of test_run/bench.
// run.ts/manual-run.ts only write output/{test_run,bench}/<ts>/{transcribe,analyze}/*.json;
// nothing renders it. This scans those trees plus the local control-group/ reference area,
// cross-references control-group/control-group.md to flag reference rows, and emits ONE
// self-contained HTML file (embedded JSON + vanilla JS,
// no server, no build step) so a developer can browse/sort/drill-down in a plain browser.
//
// The emitted file is a rendering of existing data, not run data itself — safe to
// regenerate/overwrite every call, unlike the run folders under output/test_run|bench/
// (the project policy never deletes run outputs; it does not apply to this derived view).

import fs from 'node:fs';
import path from 'node:path';

import { OUTPUT_DIR, OUTPUT_BENCH_DIR, OUTPUT_TEST_RUN_DIR, CONTROL_GROUP_DIR, benchStyleId } from './matrix.ts';
import { parseControlGroup } from './control-group.ts';

const REPORT_PATH = path.join(OUTPUT_DIR, 'report.html');

type Kind = 'test_run' | 'bench' | 'control';
type RecordingKind = 'static' | 'live';
type FileType = 'transcribe' | 'analyze';

// One row per raw file on disk — transcribe and analyze stay separate rows (they can even
// live in different run folders for the same scenario, see control-group.md) rather than
// merged, so the table reflects exactly what's on disk and each has its own reference flag.
interface FileEntry {
  kind: Kind;
  recording_kind: RecordingKind;
  runId: string;
  configId: string;
  base: string;
  type: FileType;
  filePath: string; // absolute — the single source of truth for the reference check
  isReference: boolean;
  data: Record<string, unknown>;
}

// Two filename conventions coexist on disk: nested benchmark and flat test_run output
// use `<configId>__<base>.json` inside a transcribe/analyze subfolder; manual-run.ts now
// writes flat `<base>_transcribe.json` / `<base>_live-analyze.json` directly in the run dir
// (no transcribe/analyze subfolders per manual run, and configId isn't in the filename since
// it's already inside the JSON). Both conventions must be parsed because benchmark and manual
// outputs coexist on disk.
const OLD_FILE_RE = /^(.+)__(.+)\.json$/;
const NEW_FILE_RE = /^(.+)_((?:live-)?(?:transcribe|analyze))\.json$/;

// New-style files carry no configId in the name — recover a display id from the JSON
// itself: the whisper config for a transcribe file, the LLM model for an analyze file
// (analyze has no whisper config to speak of, see manual-run.ts's outputType split).
function deriveConfigId(data: Record<string, unknown>): string {
  const cfg = data.config as { model?: string; dtype?: string; mode?: string } | undefined;
  if (cfg?.model && cfg.dtype && cfg.mode) return benchStyleId(cfg.model, cfg.dtype, cfg.mode);
  const analyzer = data.analyzer as { model?: string } | undefined;
  if (analyzer?.model) return analyzer.model;
  return 'unknown';
}

function parseFileName(
  fileName: string,
  data: Record<string, unknown>,
  folderType?: FileType,
): { base: string; type: FileType; configId: string } | null {
  const oldMatch = OLD_FILE_RE.exec(fileName);
  if (oldMatch) {
    const [, configId, base] = oldMatch;
    const type = folderType ?? (data.outputType as FileType | undefined) ?? 'transcribe';
    return { base, type, configId };
  }
  const newMatch = NEW_FILE_RE.exec(fileName);
  if (newMatch) {
    const [, base, rawType] = newMatch;
    const type: FileType = rawType.endsWith('analyze') ? 'analyze' : 'transcribe';
    return { base, type, configId: deriveConfigId(data) };
  }
  return null;
}

function readEntryFile(
  filePath: string,
  fileName: string,
  folderType: FileType | undefined,
  kind: Kind,
  runId: string,
): FileEntry | null {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const parsed = parseFileName(fileName, data, folderType);
  if (!parsed) return null;
  // Files predating the live stage carry no recordingType — they are all static runs.
  const recording_kind: RecordingKind = data.recordingType === 'live' ? 'live' : 'static';
  return { kind, recording_kind, runId, configId: parsed.configId, base: parsed.base, type: parsed.type, filePath, isReference: false, data };
}

function scanRunDir(rootDir: string, kind: Kind): FileEntry[] {
  const entries: FileEntry[] = [];
  if (!fs.existsSync(rootDir)) return entries;

  for (const runId of fs.readdirSync(rootDir)) {
    const runDir = path.join(rootDir, runId);
    if (!fs.statSync(runDir).isDirectory()) continue;

    // New layout: transcribe/analyze/live-* files sit flat in the run dir, alongside
    // summary.md / summary.json — skip anything that isn't an outputType JSON file
    // (parseFileName's own regex already rejects those, but summary.json IS valid JSON
    // and would otherwise reach JSON.parse and get silently mis-parsed as a run file).
    for (const fileName of fs.readdirSync(runDir)) {
      if (fileName === 'summary.md' || fileName === 'summary.json' || !fileName.endsWith('.json')) continue;
      const filePath = path.join(runDir, fileName);
      if (!fs.statSync(filePath).isFile()) continue;
      const entry = readEntryFile(filePath, fileName, undefined, kind, runId);
      if (entry) entries.push(entry);
    }

    // Nested layout: transcribe/ and analyze/ subfolders (bench/run.ts writes this way).
    for (const type of ['transcribe', 'analyze'] as const) {
      const subDir = path.join(runDir, type);
      if (!fs.existsSync(subDir)) continue;
      for (const fileName of fs.readdirSync(subDir)) {
        const filePath = path.join(subDir, fileName);
        const entry = readEntryFile(filePath, fileName, type, kind, runId);
        if (entry) entries.push(entry);
      }
    }

    // Bench live outputs use a parallel subtree so static and live files with the same
    // config/scenario name cannot overwrite one another.
    for (const type of ['transcribe', 'analyze'] as const) {
      const subDir = path.join(runDir, 'live', type);
      if (!fs.existsSync(subDir)) continue;
      for (const fileName of fs.readdirSync(subDir)) {
        const filePath = path.join(subDir, fileName);
        const entry = readEntryFile(filePath, fileName, type, kind, runId);
        if (entry) entries.push(entry);
      }
    }
  }
  return entries;
}

// The tracked control-group/ folder: the promoted reference outputs, laid out as
// control-group/{transcribe,analyze}/… for static references and control-group/live/
// {transcribe,analyze}/… for live ones (promote.ts) — no timestamp level (one reference per
// scenario+kind+recording). Given a synthetic runId so it slots into the same table/detail
// machinery as a real run.
function scanControlGroup(): FileEntry[] {
  const entries: FileEntry[] = [];
  const dirs: { dir: string; type: FileType }[] = [
    { dir: path.join(CONTROL_GROUP_DIR, 'transcribe'), type: 'transcribe' },
    { dir: path.join(CONTROL_GROUP_DIR, 'analyze'), type: 'analyze' },
    { dir: path.join(CONTROL_GROUP_DIR, 'live', 'transcribe'), type: 'transcribe' },
    { dir: path.join(CONTROL_GROUP_DIR, 'live', 'analyze'), type: 'analyze' },
  ];
  for (const { dir, type } of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const fileName of fs.readdirSync(dir)) {
      const filePath = path.join(dir, fileName);
      if (!fs.statSync(filePath).isFile()) continue;
      const entry = readEntryFile(filePath, fileName, type, 'control', 'control-group');
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

// Marks entries whose file is exactly the one control-group.md names for that scenario —
// reference status is a recorded judgement, never re-derived here. Registry paths are
// control-group/-relative (see control-group.ts), so they resolve against CONTROL_GROUP_DIR.
// Compares actual scanned file paths rather than reconstructing them from
// kind/runId/type/configId/base — reconstruction broke once configId left the filename.
function markReferences(entries: FileEntry[]): void {
  const controlGroup = parseControlGroup();
  const refPaths = new Set<string>();
  for (const entry of controlGroup.values()) {
    for (const rel of [entry.transcribe, entry.analyze, entry.liveTranscribe, entry.liveAnalyze]) {
      if (rel) refPaths.add(path.resolve(CONTROL_GROUP_DIR, rel));
    }
  }

  for (const e of entries) {
    e.isReference = refPaths.has(path.resolve(e.filePath));
  }
}

function renderHtml(rows: FileEntry[]): string {
  const dataJson = JSON.stringify(rows).replace(/</g, '\\u003c'); // guard against </script> in transcript text

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>Test-run / bench raporu</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; font-size: 14px; }
  h1 { font-size: 1.2rem; margin: 0 0 0.75rem; }
  .toolbar { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; }
  input[type=text] { padding: 0.35rem 0.5rem; min-width: 220px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #8884; padding: 0.3rem 0.5rem; text-align: left; white-space: nowrap; }
  th { cursor: pointer; position: sticky; top: 0; background: Canvas; }
  tbody tr:hover { background: #8882; cursor: pointer; }
  tr.ref td:first-child { border-left: 3px solid #2a7; }
  .muted { opacity: 0.6; }
  #detail { margin-top: 1rem; border-top: 1px solid #8884; padding-top: 1rem; display: none; }
  #detail.open { display: block; }
  #detail pre { white-space: pre-wrap; word-break: break-word; background: #8881; padding: 0.75rem; max-height: 60vh; overflow: auto; }
  .badge { font-size: 0.75em; padding: 0.1em 0.4em; border-radius: 3px; background: #2a7; color: #fff; }
  .type-transcribe { color: #37a; }
  .type-analyze { color: #a73; }
</style>
</head>
<body>
<h1>Test-run / bench raporu</h1>
<div class="toolbar">
  <input type="text" id="filter" placeholder="senaryo / config / kind ara...">
  <label><input type="checkbox" id="onlyRef"> yalnızca referans satırlar</label>
  <span id="count" class="muted"></span>
</div>
<table id="tbl">
  <thead>
    <tr>
      <th data-k="base">senaryo</th>
      <th data-k="type">type</th>
      <th data-k="kind">kind</th>
      <th data-k="recording_kind">recording</th>
      <th data-k="date">tarih</th>
      <th data-k="runId">run</th>
      <th data-k="configId">config</th>
      <th data-k="ref">ref</th>
      <th data-k="wer">wer↓</th>
      <th data-k="recall">recall↑</th>
      <th data-k="dup">dup</th>
      <th data-k="overlap">overlap</th>
      <th data-k="halluc">halüs.</th>
      <th data-k="rtf">rtf↓</th>
      <th data-k="rss">RSS(MB)</th>
      <th data-k="disk">disk(MB)</th>
    </tr>
  </thead>
  <tbody></tbody>
</table>
<div id="detail"></div>
<script>
const DATA = ${dataJson};

function fmt(v) { return v === null || v === undefined ? 'n/a' : v; }

// Converts folder timestamp (2026-07-20T07-26-26-512Z) to readable local date
function parseRunTime(runId) {
  if (runId === 'control-group') return '-';
  // Replace the hyphens in the time portion with colons and strip ms
  const fixedIso = runId.replace(/T(\\d{2})-(\\d{2})-(\\d{2}).*Z$/, 'T$1:$2:$3Z');
  const d = new Date(fixedIso);
  return isNaN(d) ? runId : d.toLocaleString('tr-TR', { 
    year: 'numeric', month: '2-digit', day: '2-digit', 
    hour: '2-digit', minute: '2-digit', second: '2-digit' 
  });
}

function row(e) {
  const m = e.type === 'transcribe' ? e.data.metrics : null;
  const dr = m?.domainRecall;
  return {
    raw: e,
    kind: e.kind, recording_kind: e.recording_kind, runId: e.runId, configId: e.configId, base: e.base, type: e.type,
    date: parseRunTime(e.runId),
    ref: e.isReference,
    wer: m ? fmt(m.wer) : '', recall: dr ? \`\${dr.found}/\${dr.total}\` : '',
    dup: m ? fmt(m.duplicateFlags) : '', overlap: m ? fmt(m.overlapFlags) : '',
    halluc: m ? fmt(m.hallucinationSentences) : '',
    rtf: m?.rtf != null ? m.rtf.toFixed(2) : (m ? 'n/a' : ''),
    rss: m ? fmt(m.peakRssMB) : '', disk: m ? fmt(m.diskMB) : '',
  };
}

let rows = DATA.map(row);
let sortKey = 'runId', sortDir = -1;

function applyFilters() {
  const q = document.getElementById('filter').value.trim().toLowerCase();
  const onlyRef = document.getElementById('onlyRef').checked;
  let view = rows;
  if (onlyRef) view = view.filter((r) => r.ref);
  if (q) view = view.filter((r) => \`\${r.kind} \${r.recording_kind} \${r.runId} \${r.configId} \${r.base} \${r.type}\`.toLowerCase().includes(q));
  view = view.slice().sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av === bv) return 0;
    return (av > bv ? 1 : -1) * sortDir;
  });
  render(view);
}

function render(view) {
  const tbody = document.querySelector('#tbl tbody');
  tbody.innerHTML = '';
  for (const r of view) {
    const tr = document.createElement('tr');
    if (r.ref) tr.className = 'ref';
    // Swapped r.date and r.runId order here to match the new headers
    tr.innerHTML = \`<td>\${r.base}</td><td class="type-\${r.type}">\${r.type}</td><td>\${r.kind}</td><td>\${r.recording_kind}</td><td>\${r.date}</td><td title="\${r.runId}">\${r.runId.substring(0,8)}...</td><td>\${r.configId}</td>
      <td>\${r.ref ? '<span class="badge">ref</span>' : ''}</td>
      <td>\${r.wer}</td><td>\${r.recall}</td><td>\${r.dup}</td><td>\${r.overlap}</td>
      <td>\${r.halluc}</td><td>\${r.rtf}</td><td>\${r.rss}</td><td>\${r.disk}</td>\`;
    tr.addEventListener('click', () => showDetail(r.raw));
    tbody.appendChild(tr);
  }
  document.getElementById('count').textContent = \`\${view.length} / \${rows.length} satır\`;
}

// Dumps the exact JSON on disk for this file — no reshaping, so nothing in the source
// record is ever hidden from the drill-down.
function showDetail(e) {
  const detail = document.getElementById('detail');
  detail.classList.add('open');
  const title = \`\${e.base} — \${e.type}\${e.isReference ? ' <span class="badge">ref</span>' : ''} (\${e.configId}, \${e.kind}/\${e.runId})\`;
  detail.innerHTML = \`<h2>\${title}</h2><pre>\${escapeHtml(JSON.stringify(e.data, null, 2))}</pre>\`;
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('filter').addEventListener('input', applyFilters);
document.getElementById('onlyRef').addEventListener('change', applyFilters);
document.querySelectorAll('#tbl th').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
    applyFilters();
  });
});

applyFilters();
</script>
</body>
</html>
`;
}

function main(): void {
  const entries = [
    ...scanRunDir(OUTPUT_TEST_RUN_DIR, 'test_run'),
    ...scanRunDir(OUTPUT_BENCH_DIR, 'bench'),
    ...scanControlGroup(),
  ];
  markReferences(entries);

  entries.sort((a, b) => a.runId.localeCompare(b.runId));
  fs.writeFileSync(REPORT_PATH, renderHtml(entries), 'utf8');
  console.log(`${entries.length} kayıt yazıldı: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
