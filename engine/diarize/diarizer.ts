// Isolated Pyannote adapter. Python/PyTorch stays in a child process so native
// failures cannot take down the Electron/ONNX Whisper process.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DIARIZATION_DEVICE,
  getDiarizationConfig,
  RESULT_MARKER,
  STATS_MARKER,
  type DiarizationConfig,
} from '../diarization-config.ts';

export interface SpeakerSegment {
  start: number;
  end: number;
  speaker: string;
}

// What the worker measured about its own run. Mirrors the __DIAR_STATS__ payload; every
// field is optional because an older worker (or one that died mid-run) emits no stats
// line at all, and a missing measurement must not read as a zero.
export interface DiarizationStats {
  requested?: string;
  device?: string;
  torch?: string;
  cudaAvailable?: boolean;
  gpuName?: string | null;
  fellBack?: boolean;
  fallbackReason?: string | null;
  audioSec?: number;
  loadMs?: number | null;
  pipelineMs?: number | null;
  embedMs?: number | null;
  clusterMs?: number | null;
  refineMs?: number | null;
  windowCount?: number | null;
  windowClusteringSkipped?: string;
  totalMs?: number;
  speakerCount?: number;
  turnCount?: number;
  peakVramMB?: number | null;
  peakRssMB?: number | null;
}

// asar is a virtual archive: Electron patches Node's fs to see through it, but a
// spawned Python has no such shim and would get ENOENT. electron-builder keeps the
// worker as a real file under app.asar.unpacked (see electron-builder.yml), so the
// path has to point there. Outside a package the segment is absent and this is a
// no-op, which keeps the engine CLI and bench runs on the same code path.
const WORKER_PATH = fileURLToPath(new URL('./pyannote-worker.py', import.meta.url))
  .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

function isReady(cfg: DiarizationConfig): boolean {
  return cfg.enabled && !!cfg.pythonPath && !!cfg.modelDir && fs.existsSync(cfg.pythonPath) && fs.existsSync(cfg.modelDir);
}

export function warmUp(): Promise<null> {
  const cfg = getDiarizationConfig();
  if (!cfg.enabled) console.log('[diarizer] disabled in Settings — transcription stays speaker-less.');
  else if (!isReady(cfg)) console.warn('[diarizer] Pyannote is not installed; continuing without speaker labels.');
  return Promise.resolve(null);
}

export function parseDiarizationStats(stdout: string): DiarizationStats | null {
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith(STATS_MARKER));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(STATS_MARKER.length));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as DiarizationStats;
  } catch {
    return null;
  }
}

export function parseDiarizationResult(stdout: string): SpeakerSegment[] | null {
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith(RESULT_MARKER));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(RESULT_MARKER.length));
    if (!Array.isArray(parsed)) return null;
    const turns = parsed.filter((turn): turn is SpeakerSegment => {
      if (!turn || typeof turn !== 'object') return false;
      const value = turn as Record<string, unknown>;
      return Number.isFinite(value.start) && Number.isFinite(value.end) && typeof value.speaker === 'string';
    });
    return turns.map((turn) => ({ start: turn.start, end: turn.end, speaker: turn.speaker }));
  } catch {
    return null;
  }
}

export interface DiarizationRun {
  segments: SpeakerSegment[] | null;
  stats: DiarizationStats | null;
}

// The measuring entry point. diarize() below stays the shape the three production
// callers expect, so adding timings did not have to ripple through them.
export async function diarizeWithStats(
  audioPath: string,
  timeoutMs: number = WORKER_TIMEOUT_MS,
  config: DiarizationConfig = getDiarizationConfig(),
  signal?: AbortSignal,
): Promise<DiarizationRun> {
  if (!config.enabled) return { segments: null, stats: null };
  if (!isReady(config)) {
    console.warn('[diarizer] Pyannote is not ready; continuing without speaker labels.');
    return { segments: null, stats: null };
  }
  if (signal?.aborted) return { segments: null, stats: null };

  const device = config.device ?? DEFAULT_DIARIZATION_DEVICE;

  return new Promise((resolve) => {
    const child = spawn(config.pythonPath!, [WORKER_PATH, audioPath, config.modelDir!, device], {
      env: { ...process.env, PYANNOTE_METRICS_ENABLED: '0', HF_HUB_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const finish = (result: DiarizationRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      console.warn('[diarizer] Pyannote worker timed out; continuing without speaker labels.');
      child.kill('SIGKILL');
      finish({ segments: null, stats: null });
    }, timeoutMs);
    // A cancelled meeting must not leave a GPU worker grinding for the rest of its
    // timeout — the same SIGKILL the deadline uses, just triggered by the user. The
    // child holds the only reference to the model's VRAM, so killing it is what
    // actually frees the machine.
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish({ segments: null, stats: null });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (error) => {
      console.warn(`[diarizer] failed to start Pyannote (${error.message}). Continuing without speaker labels.`);
      finish({ segments: null, stats: null });
    });
    child.on('close', (code) => {
      // Stats are kept even on a non-zero exit: a worker that measured its load and
      // then died still tells you where it died.
      const stats = parseDiarizationStats(stdout);
      if (code !== 0) return finish({ segments: null, stats });
      finish({ segments: parseDiarizationResult(stdout), stats });
    });
  });
}

export async function diarize(
  audioPath: string,
  timeoutMs: number = WORKER_TIMEOUT_MS,
  config: DiarizationConfig = getDiarizationConfig(),
  signal?: AbortSignal,
): Promise<SpeakerSegment[] | null> {
  return (await diarizeWithStats(audioPath, timeoutMs, config, signal)).segments;
}
