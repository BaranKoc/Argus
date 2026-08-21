// npm run bench — non-interactive model benchmark harness. See docs/model-selection.md.
//
// TWO STAGES, deliberately decoupled so a failed analyze can't lose transcribe work:
//   Stage T (transcribe): each runnable config x file -> transcribe in an isolated
//     worker, compute metrics vs the control-group reference, write to transcribe/ RIGHT
//     AWAY (as each file's result streams in, not at config end). This is the expensive part.
//   Stage A (analyze): ONLY after ALL of T is on disk, run the LLM analyzer over each
//     transcript, failure-isolated (Ollama down / model missing -> record 'failed',
//     never abort). So "bench succeeded but analyze returned empty" keeps every transcript.
//
// Output: output/bench/<timestamp>/{transcribe,analyze}/<configId>__<file>.json + summary.{md,json}
//
// Reference for wer/hallucination = whatever control-group/control-group.md names (control-group.ts).
// Runnable configs are filtered up front by the same file-presence check as check-models,
// so missing turbo variants are reported as "atlandı — indirilmemiş", not a mid-run crash.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../index.ts';
import {
  BENCH_MATRIX,
  BENCH_FILES,
  BENCH_RECORDING_TYPES,
  BENCH_LOCK_PATH,
  BENCH_TASK_COUNT,
  DOMAIN_TERMS,
  OUTPUT_BENCH_DIR,
  BENCH_RESULT_MARKER,
  runStamp,
  whisperFileStatus,
  type BenchConfig,
} from './matrix.ts';
import { controlGroupText } from './control-group.ts';
import { buildMetrics, formatMetricLine, metricsTableRow, METRICS_TABLE_HEADER } from './metrics.ts';
import type { Segment } from '../transcribe/transcriber.ts';

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
type RecordingType = 'static' | 'live';
const BENCH_PAUSE_MS = 10_000;

function acquireBenchLock(): void {
  fs.mkdirSync(OUTPUT_BENCH_DIR, { recursive: true });
  try {
    const fd = fs.openSync(BENCH_LOCK_PATH, 'wx');
    fs.writeFileSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    let owner = 'unknown';
    try { owner = fs.readFileSync(BENCH_LOCK_PATH, 'utf8').trim() || owner; } catch { /* raced with cleanup */ }
    throw new Error(`başka bir bench zaten çalışıyor (PID ${owner})`);
  }
  process.on('exit', () => {
    try { fs.unlinkSync(BENCH_LOCK_PATH); } catch { /* already removed */ }
  });
}

// Budget per FILE, measured from the worker's last output — not per config. A config now
// covers every scenario including S8 (~45 min of audio), so a total-duration cap would
// either kill healthy long runs or be so large it never catches a genuine hang. Silence
// is the real hang signal.
const WORKER_IDLE_TIMEOUT_MS = 40 * 60 * 1000;

interface WorkerFileResult {
  kind: 'file';
  file: string;
  recordingType: RecordingType;
  durationSec?: number;
  ms?: number;
  text?: string;
  segments?: Segment[];
  error?: string;
  loadMs: number;
  peakRss: number;
  config: unknown;
}

// Run one config's worker in an isolated process, invoking onFile as each file's result
// streams in so the caller can checkpoint it before the worker finishes. Rejects only on
// spawn error / idle timeout / a worker that produced nothing at all; a worker that dies
// after emitting some files resolves, keeping what it managed to produce.
function runWorker(cfg: BenchConfig, tasks: string[], onFile: (r: WorkerFileResult) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      env: {
        ...process.env,
        ENGINE_MODEL: cfg.model,
        ENGINE_DTYPE: cfg.dtype,
        ENGINE_TRANSCRIBE_MODE: cfg.mode,
        ENGINE_BENCH_TASKS: tasks.join(','),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let buf = '';
    let seen = 0;
    let timer: NodeJS.Timeout;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`worker ${WORKER_IDLE_TIMEOUT_MS / 60000} dk sessiz kaldı (${seen} dosya alındı)`));
      }, WORKER_IDLE_TIMEOUT_MS);
    };
    arm();

    child.stdout.on('data', (c) => {
      arm(); // any output means it's alive
      buf += c.toString();
      // Keep the trailing partial line in the buffer — a result line can span chunks.
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith(BENCH_RESULT_MARKER)) continue;
        let msg: { kind: string };
        try {
          msg = JSON.parse(line.slice(BENCH_RESULT_MARKER.length));
        } catch {
          continue; // a mangled line must not abort a run that's otherwise fine
        }
        if (msg.kind === 'file') {
          seen++;
          onFile(msg as WorkerFileResult);
        }
      }
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (seen === 0) return reject(new Error(`worker gave no result (exit ${code})`));
      if (code !== 0) console.error(`  worker exit ${code} — ${seen} dosya alındı, devam ediliyor.`);
      resolve();
    });
  });
}

function transcriptPath(runDir: string, cfg: BenchConfig, file: string, recordingType: RecordingType): string {
  const dir = recordingType === 'live' ? path.join(runDir, 'live', 'transcribe') : path.join(runDir, 'transcribe');
  return path.join(dir, `${cfg.id}__${file}.json`);
}

function readTranscript(pathname: string, id: string, file: string, recordingType: RecordingType): TRecord | null {
  try {
    const data = JSON.parse(fs.readFileSync(pathname, 'utf8')) as { text?: unknown; metrics?: unknown; segments?: unknown };
    if (typeof data.text !== 'string' || !Array.isArray(data.segments) || !data.metrics || typeof data.metrics !== 'object') return null;
    return { id, file, recordingType, text: data.text, metrics: data.metrics as Record<string, unknown> };
  } catch {
    return null;
  }
}

interface TRecord {
  id: string;
  file: string;
  recordingType: RecordingType;
  text: string;
  metrics: Record<string, unknown>;
}

function collectTranscriptRecords(runDir: string): TRecord[] {
  const records: TRecord[] = [];
  for (const cfg of BENCH_MATRIX) {
    for (const file of BENCH_FILES) {
      for (const recordingType of ['static', 'live'] as const) {
        const record = readTranscript(transcriptPath(runDir, cfg, file, recordingType), cfg.id, file, recordingType);
        if (record) records.push(record);
      }
    }
  }
  return records;
}

// Sum on-disk size of the ONNX files a config needs (disk budget metric).
function configDiskBytes(cfg: BenchConfig): number {
  return whisperFileStatus(cfg.model, cfg.dtype).required.reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);
}

async function main(): Promise<void> {
  acquireBenchLock();
  const resume = process.env.ENGINE_BENCH_RESUME_DIR?.trim();
  const runDir = resume ? path.resolve(resume) : path.join(OUTPUT_BENCH_DIR, runStamp());
  if (path.relative(OUTPUT_BENCH_DIR, runDir).startsWith('..')) {
    throw new Error(`resume dizini output/bench altında olmalı: ${runDir}`);
  }
  const transcribeDir = path.join(runDir, 'transcribe');
  const analyzeDir = path.join(runDir, 'analyze');
  fs.mkdirSync(transcribeDir, { recursive: true });
  fs.mkdirSync(analyzeDir, { recursive: true });

  // Filter to configs whose weights are present (same check as check-models).
  const runnable: BenchConfig[] = [];
  const skipped: { cfg: BenchConfig; missing: string[] }[] = [];
  for (const cfg of BENCH_MATRIX) {
    const { missing } = whisperFileStatus(cfg.model, cfg.dtype);
    if (missing.length === 0) runnable.push(cfg);
    else skipped.push({ cfg, missing });
  }

  console.log(`Bench çıktı dizini: ${runDir}${resume ? ' (devam)' : ''}`);
  console.log(`Planlanan görev sayısı: ${BENCH_TASK_COUNT} (görevler arasında en az 10 sn, tek worker sırası)`);
  console.log(`Çalıştırılacak: ${runnable.map((c) => c.id).join(', ') || '(yok)'}`);
  if (skipped.length) console.log(`Atlanan (indirilmemiş): ${skipped.map((s) => s.cfg.id).join(', ')}`);

  // ---- Stage T: transcribe + metrics, checkpoint each result immediately ----
  for (const [cfgIndex, cfg] of runnable.entries()) {
    if (cfgIndex > 0) await new Promise((resolve) => setTimeout(resolve, BENCH_PAUSE_MS));
    const tasks = BENCH_FILES.flatMap((file) => BENCH_RECORDING_TYPES
      .filter((recordingType) => !readTranscript(transcriptPath(runDir, cfg, file, recordingType), cfg.id, file, recordingType))
      .map((recordingType) => `${recordingType}:${file}`));
    if (tasks.length === 0) {
      console.log(`\n=== [T] ${cfg.id} === tamam, checkpoint kullanılıyor.`);
      continue;
    }
    console.log(`\n=== [T] ${cfg.id} ===`);
    console.log(`  devam edilecek görev: ${tasks.join(', ')}`);
    const diskBytes = configDiskBytes(cfg);

    // Each file is written the moment it arrives, before the worker moves to the next —
    // this is what survives a worker that dies partway through a multi-hour config.
    const onFile = (r: WorkerFileResult): void => {
      const outputDir = r.recordingType === 'live' ? path.join(runDir, 'live', 'transcribe') : transcribeDir;
      fs.mkdirSync(outputDir, { recursive: true });
      const outPath = path.join(outputDir, `${cfg.id}__${r.file}.json`);
      if (r.error || !r.segments || r.text == null) {
        fs.writeFileSync(outPath, JSON.stringify({ config: r.config, file: r.file, recordingType: r.recordingType, outputType: 'transcribe', error: r.error ?? 'boş sonuç' }, null, 2));
        console.log(`  ${r.file}: HATA — ${r.error ?? 'boş sonuç'}`);
        return;
      }
      const metrics = buildMetrics(
        { text: r.text, segments: r.segments, durationSec: r.durationSec, ms: r.ms, loadMs: r.loadMs, peakRss: r.peakRss, diskBytes },
        controlGroupText(r.file, r.recordingType),
        DOMAIN_TERMS[r.file] ?? [],
      );
      fs.writeFileSync(
        outPath,
        JSON.stringify({ config: r.config, file: r.file, recordingType: r.recordingType, outputType: 'transcribe', metrics, text: r.text, segments: r.segments }, null, 2),
      );
      console.log(`  ${r.recordingType} ${r.file}: ${formatMetricLine(r.file, metrics)}`);
    };

    try {
      await runWorker(cfg, tasks, onFile);
    } catch (e) {
      console.error(`  worker hatası: ${(e as Error).message}`);
      skipped.push({ cfg, missing: ['(worker hatası)'] });
    }
  }

  const tRecords = collectTranscriptRecords(runDir);

  // ---- Stage A: analyze each transcript, failure-isolated ----
  console.log(`\n=== [A] analyze (${tRecords.length} transkript) ===`);
  let aOk = 0;
  let aFail = 0;
  for (const rec of tRecords) {
    const outputDir = rec.recordingType === 'live' ? path.join(runDir, 'live', 'analyze') : analyzeDir;
    fs.mkdirSync(outputDir, { recursive: true });
    const outPath = path.join(outputDir, `${rec.id}__${rec.file}.json`);
    try {
      const analysis = await analyze(rec.text);
      fs.writeFileSync(outPath, JSON.stringify({ id: rec.id, file: rec.file, recordingType: rec.recordingType, outputType: 'analyze', status: 'success', analysis }, null, 2));
      aOk++;
    } catch (e) {
      fs.writeFileSync(
        outPath,
        JSON.stringify({ id: rec.id, file: rec.file, recordingType: rec.recordingType, outputType: 'analyze', status: 'failed', error: (e as Error).message }, null, 2),
      );
      aFail++;
    }
  }
  console.log(`  analyze: ${aOk} başarılı, ${aFail} başarısız (transcribe çıktıları etkilenmez).`);

  // ---- Summary ----
  writeSummary(runDir, tRecords, skipped, aOk, aFail);
  console.log(`\nÖzet: ${path.join(runDir, 'summary.md')}`);
}

function writeSummary(
  runDir: string,
  tRecords: { id: string; file: string; recordingType: RecordingType; metrics: Record<string, unknown> }[],
  skipped: { cfg: BenchConfig; missing: string[] }[],
  aOk: number,
  aFail: number,
): void {
  const md = [
    `# Benchmark — ${path.basename(runDir)}`,
    '',
    'Referans: `control-group/control-group.md`\'de o senaryo için yazılı çıktı. "wer" = referanstan',
    'sapma, mutlak doğruluk değil — asıl sinyal domain recall + insan gözü. Referansı olmayan',
    'senaryoda wer `n/a` gelir. S3-F için duplicate=1 beklenir (S3 dedup regresyon koruması).',
    '',
    ...METRICS_TABLE_HEADER,
    ...tRecords.map((r) => metricsTableRow(r.id, `${r.recordingType}:${r.file}`, r.metrics)),
    '',
    `Analyze: ${aOk} başarılı, ${aFail} başarısız.`,
    skipped.length ? `\nAtlanan config'ler (indirilmemiş/hatalı): ${skipped.map((s) => s.cfg.id).join(', ')}` : '',
  ].join('\n');
  fs.writeFileSync(path.join(runDir, 'summary.md'), md);
  fs.writeFileSync(
    path.join(runDir, 'summary.json'),
    JSON.stringify({ records: tRecords, skipped: skipped.map((s) => ({ id: s.cfg.id, missing: s.missing })), analyze: { ok: aOk, fail: aFail } }, null, 2),
  );
}

main().catch((e) => {
  console.error(`[bench] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
