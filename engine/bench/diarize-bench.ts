// Times ONLY diarization, on one or more devices, over one or more scenarios.
//
// The manual tool's live-transcribe stage already produces a diarizeMs, but it runs a
// full Whisper pass first — measuring S8 on two devices that way burns ~26 minutes of
// ASR nobody is looking at. This tool decodes the audio once and then does nothing but
// spawn the Pyannote worker, so the number it reports is diarization and only that.
//
//   npm run diarize-bench -w engine -- --files S6-C.mp3 --devices cpu,cuda
//   npm run diarize-bench -w engine -- --files S8.mp3 --devices cpu,cuda --repeat 2
//
// Output: output/diarize-bench/<timestamp>/{results.json,summary.md}. Nothing here is a
// control-group candidate — there is no reference to diff a duration against — so this
// writes outside output/test_run/ and prune-test-run never sees it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MODELS_DIR,
  PYANNOTE_MODEL_VERSION,
  PYANNOTE_PROVIDER,
  SAMPLE_RATE,
  type DiarizationDevice,
} from '../diarization-config.ts';
import { diarizeWithStats, type DiarizationStats, type SpeakerSegment } from '../diarize/diarizer.ts';
import { loadAudio } from '../transcribe/audio.ts';
import { writeJson, writeMonoPcm16Wav } from '../test/manual-utils.ts';
import { speakerReport, type SpeakerReport } from '../test/speaker-report.ts';
import { OUTPUT_DIR, ROOT, runStamp, TEST_MEDIA_DIR } from './matrix.ts';

const OUTPUT_DIARIZE_BENCH_DIR = path.join(OUTPUT_DIR, 'diarize-bench');
const MODEL_DIR = path.join(MODELS_DIR, 'pyannote', PYANNOTE_MODEL_VERSION);

// The CUDA runtime is the one that ships; the CPU one exists only so this benchmark can
// still time the two against each other. Both are probed for either interpreter layout
// (relocatable CPython puts python.exe at the root, a venv under Scripts/), the same way
// src/main/settings.ts resolves the packaged one — which also lets the developer venv
// from download-pyannote.ts stand in for the CPU arm.
const CUDA_RUNTIME = path.join(ROOT, 'build', 'pyannote-runtime-cuda');
const CPU_RUNTIME = path.join(ROOT, 'build', 'pyannote-runtime-cpu');
const DEV_VENV = path.join(MODELS_DIR, 'pyannote', 'runtime');

const DEFAULT_PYTHON_ROOTS: Record<DiarizationDevice, string[]> = {
  cpu: [CPU_RUNTIME, DEV_VENV],
  cuda: [CUDA_RUNTIME],
  auto: [CUDA_RUNTIME, CPU_RUNTIME, DEV_VENV],
};

// A CPU run of a 25-minute meeting has no measured precedent in this repo, so the ceiling
// is generous on purpose: killing the very run we are trying to time would be the one
// unrecoverable outcome. computeDiarizeTimeoutMs's 10-minute floor is far too tight here.
const DEFAULT_TIMEOUT_SCALE = 6;
const TIMEOUT_OVERHEAD_MS = 60_000;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function list(name: string, fallback: string[]): string[] {
  const raw = option(name);
  if (!raw) return fallback;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function interpreterIn(root: string): string | null {
  for (const relative of process.platform === 'win32' ? ['python.exe', 'Scripts/python.exe'] : ['bin/python']) {
    const candidate = path.join(root, ...relative.split('/'));
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePython(device: DiarizationDevice): string {
  const override = option(`--python-${device}`);
  if (override) {
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved)) throw new Error(`Python bulunamadı: ${resolved}`);
    return resolved;
  }
  for (const root of DEFAULT_PYTHON_ROOTS[device]) {
    const found = interpreterIn(root);
    if (found) return found;
  }
  const hint = device === 'cpu'
    ? 'npm run build-pyannote-runtime -w engine -- --cpu'
    : 'npm run build-pyannote-runtime -w engine';
  throw new Error(`${device} için Python çalışma zamanı yok. Önce: ${hint}`);
}

function isDevice(value: string): value is DiarizationDevice {
  return value === 'cpu' || value === 'cuda' || value === 'auto';
}

interface Row {
  file: string;
  audioSec: number;
  device: DiarizationDevice;
  run: number;
  ok: boolean;
  stats: DiarizationStats | null;
  report: SpeakerReport | null;
}

function seconds(ms: number | null | undefined): string {
  return ms == null ? '—' : (ms / 1000).toFixed(1);
}

function summaryTable(rows: Row[]): string {
  const header = [
    '| dosya | ses(s) | aygıt | # | toplam(s) | rtf | yükleme | pipeline | embed | küme | refine | pencere | konuşmacı | turn | VRAM(MB) | RSS(MB) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const body = rows.map((row) => {
    const s = row.stats;
    if (!row.ok || !s) {
      return `| ${row.file} | ${row.audioSec.toFixed(1)} | ${row.device} | ${row.run} | **başarısız** | — | — | — | — | — | — | — | — | — | — | — |`;
    }
    const rtf = s.totalMs != null && row.audioSec > 0 ? (s.totalMs / 1000 / row.audioSec).toFixed(3) : '—';
    // s.device, not row.device: a CUDA run that fell back to CPU must not be read as a GPU result.
    const actual = s.fellBack ? `${s.device}*` : s.device ?? row.device;
    return `| ${row.file} | ${row.audioSec.toFixed(1)} | ${actual} | ${row.run} | ${seconds(s.totalMs)} | ${rtf} `
      + `| ${seconds(s.loadMs)} | ${seconds(s.pipelineMs)} | ${seconds(s.embedMs)} | ${seconds(s.clusterMs)} `
      + `| ${seconds(s.refineMs)} | ${s.windowCount ?? '—'} | ${row.report?.speakerCount ?? '—'} `
      + `| ${row.report?.turns ?? '—'} | ${s.peakVramMB ?? '—'} | ${s.peakRssMB ?? '—'} |`;
  });
  return [...header, ...body].join('\n');
}

function speedupSection(rows: Row[]): string {
  const lines: string[] = [];
  for (const file of [...new Set(rows.map((row) => row.file))]) {
    const best = (device: string): number | null => {
      const times = rows
        .filter((row) => row.file === file && row.ok && row.stats?.device === device && !row.stats.fellBack)
        .map((row) => row.stats!.totalMs)
        .filter((ms): ms is number => ms != null);
      return times.length ? Math.min(...times) : null;
    };
    const cpu = best('cpu');
    const cuda = best('cuda');
    if (cpu == null || cuda == null) {
      lines.push(`- **${file}** — karşılaştırma yok (cpu: ${seconds(cpu)}s, cuda: ${seconds(cuda)}s).`);
      continue;
    }
    lines.push(
      `- **${file}** — CPU ${(cpu / 60000).toFixed(1)} dk → GPU ${(cuda / 60000).toFixed(1)} dk `
      + `= **${(cpu / cuda).toFixed(1)}×** hızlanma.`,
    );
  }
  return lines.join('\n');
}

async function measure(
  audioName: string,
  base: string,
  wavPath: string,
  audioSec: number,
  device: DiarizationDevice,
  python: string,
  run: number,
  timeoutScale: number,
): Promise<Row> {
  const timeoutMs = audioSec * 1000 * timeoutScale + TIMEOUT_OVERHEAD_MS;
  console.log(`\n=== ${base} · ${device} · #${run} ===  ses: ${audioSec.toFixed(1)}s  (en fazla ${(timeoutMs / 60000).toFixed(0)} dk)`);

  const started = performance.now();
  const { segments, stats } = await diarizeWithStats(wavPath, timeoutMs, {
    enabled: true,
    provider: PYANNOTE_PROVIDER,
    pythonPath: python,
    modelDir: MODEL_DIR,
    modelVersion: PYANNOTE_MODEL_VERSION,
    device,
  });
  const wallMs = performance.now() - started;

  if (!segments) {
    console.warn(`  başarısız (${(wallMs / 1000).toFixed(1)}s) — worker sonuç üretmedi.`);
    return { file: base, audioSec, device, run, ok: false, stats, report: null };
  }

  // speakerReport reads transcript segments; diarization turns carry no text, and an
  // empty one keeps the shared report rather than a second copy of the same counting.
  const report = speakerReport(segments.map((turn: SpeakerSegment) => ({ ...turn, text: '' })));
  console.log(
    `  ${seconds(stats?.totalMs ?? wallMs)}s · ${stats?.device ?? device}${stats?.fellBack ? ' (fallback)' : ''}`
    + ` · ${report.speakerCount} konuşmacı · ${report.turns} turn`
    + (stats?.peakVramMB != null ? ` · VRAM ${stats.peakVramMB} MB` : ''),
  );
  if (stats?.fallbackReason) console.warn(`  ! ${stats.fallbackReason}`);
  if (stats?.windowClusteringSkipped) console.warn(`  ! pencere kümeleme atlandı: ${stats.windowClusteringSkipped}`);

  return { file: base, audioSec, device, run, ok: true, stats, report };
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Kullanım: npm run diarize-bench -w engine -- [--files S6-C.mp3,S8.mp3] [--devices cpu,cuda]'
      + ' [--repeat 1] [--python-cpu <yol>] [--python-cuda <yol>] [--timeout-scale 6]');
    return;
  }
  if (!fs.existsSync(MODEL_DIR)) {
    throw new Error(`Pyannote modeli yok: ${MODEL_DIR}\nÖnce: npm run download-pyannote -w engine`);
  }

  const files = list('--files', ['S6-C.mp3']);
  const devices = list('--devices', ['cpu']).map((value) => {
    if (!isDevice(value)) throw new Error(`Bilinmeyen aygıt: ${value} (cpu|cuda|auto)`);
    return value;
  });
  const repeat = Math.max(1, Number(option('--repeat') ?? 1));
  const timeoutScale = Math.max(1, Number(option('--timeout-scale') ?? DEFAULT_TIMEOUT_SCALE));

  // Resolved up front: discovering a missing CUDA runtime after a 20-minute CPU run
  // would waste the expensive half of the comparison.
  const pythons = new Map<DiarizationDevice, string>();
  for (const device of devices) pythons.set(device, resolvePython(device));
  for (const [device, python] of pythons) console.log(`${device}: ${python}`);

  const stamp = runStamp();
  const runDir = path.join(OUTPUT_DIARIZE_BENCH_DIR, stamp);
  fs.mkdirSync(runDir, { recursive: true });

  const rows: Row[] = [];
  for (const audioName of files) {
    const audioPath = path.join(TEST_MEDIA_DIR, audioName);
    if (!fs.existsSync(audioPath)) throw new Error(`Ses dosyası yok: ${audioPath}`);
    const base = path.parse(audioName).name;

    // Decoded once and reused by every device/repeat, so decode cost can never leak
    // into one device's number and not the other's.
    const pcm = await loadAudio(audioPath);
    const audioSec = pcm.length / SAMPLE_RATE;
    const wavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-diar-bench-'));
    const wavPath = path.join(wavDir, `${base}.wav`);
    writeMonoPcm16Wav(wavPath, pcm, SAMPLE_RATE);

    try {
      for (let run = 1; run <= repeat; run++) {
        for (const device of devices) {
          rows.push(await measure(audioName, base, wavPath, audioSec, device, pythons.get(device)!, run, timeoutScale));
        }
      }
    } finally {
      fs.rmSync(wavDir, { recursive: true, force: true });
    }

    // Written after every scenario: S8 is long enough that a crash on the last file
    // must not take the earlier measurements with it.
    writeJson(path.join(runDir, 'results.json'), { stamp, model: PYANNOTE_MODEL_VERSION, rows });
    fs.writeFileSync(
      path.join(runDir, 'summary.md'),
      `# Konuşmacı ayrımı hız ölçümü — ${stamp}\n\n`
      + `Model: \`${PYANNOTE_MODEL_VERSION}\` · tekrar: ${repeat}\n\n`
      + 'Yalnız diarization ölçülür; Whisper bu araçta hiç çalışmaz. Kontrol grubu yoktur —\n'
      + 'konuşmacı/turn sütunları bilgi amaçlıdır, kabul ölçütü değildir. `*` = istenen aygıt\n'
      + 'tutmadı, CPU\'ya düşüldü. `yükleme` pyannote import\'unu ve model yüklemesini birlikte\n'
      + 'içerir, yani fazlar `toplam`a yaklaşık olarak toplanır.\n\n'
      + `${summaryTable(rows)}\n\n## Hızlanma\n\n${speedupSection(rows)}\n`,
      'utf8',
    );
  }

  console.log(`\nÖzet: ${path.join(runDir, 'summary.md')}`);
  console.log(`\n${speedupSection(rows)}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Ölçüm başarısız oldu.');
  process.exitCode = 1;
});
