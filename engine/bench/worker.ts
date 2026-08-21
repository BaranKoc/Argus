// Bench worker — transcribes every BENCH_FILES entry for the ONE config passed via
// ENGINE_MODEL/ENGINE_DTYPE/ENGINE_TRANSCRIBE_MODE env, emitting one
// `__BENCH_RESULT__<json>` line PER FILE plus a final {kind:'done'} line, which the
// parent (run.ts) parses.
//
// WHY A CHILD PROCESS PER CONFIG: the ASR pipeline in transcriber.ts is a module-level
// singleton (loaded once, reused). To benchmark multiple models we must isolate each in
// its own process — otherwise config #2 would silently reuse config #1's loaded model.
// It also gives an accurate per-config peak RSS and model-load time.
//
// WHY PER-FILE LINES INSTEAD OF ONE FINAL BLOB: the run covers every scenario including
// S8 (~45 min of audio), so a config takes hours. Buffering results until the end meant
// any timeout/crash threw away the whole config's work, and the parent's timeout could
// not tell "still grinding on S8" from "hung". Emitting per file lets run.ts checkpoint
// each result immediately and time out on SILENCE rather than total duration.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { transcribe, segmentsToDialogue, warmUp } from '../index.ts';
import { loadAudio } from '../transcribe/audio.ts';
import { configSnapshot, getLiveConfig, SAMPLE_RATE } from '../models.ts';
import { ChunkQueue } from '../live/chunk-queue.ts';
import { flagBoundaryOrphans } from '../live/seam-dedup.ts';
import type { Segment } from '../transcribe/transcriber.ts';
import { BENCH_FILES, BENCH_RECORDING_TYPES, TEST_MEDIA_DIR, BENCH_RESULT_MARKER } from './matrix.ts';

const BENCH_PAUSE_MS = 10_000;

function selectedTasks(): Set<string> | null {
  const raw = process.env.ENGINE_BENCH_TASKS?.trim();
  if (!raw) return null;
  return new Set(raw.split(',').map((task) => task.trim()).filter(Boolean));
}

// Sample RSS while we work so the reported peak reflects the whole run, not a snapshot.
let peakRss = process.memoryUsage().rss;
const rssTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 200);

function emit(payload: unknown): void {
  process.stdout.write(`\n${BENCH_RESULT_MARKER}${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const loadStart = performance.now();
  await warmUp(); // pay the model-load cost up front so it's not folded into file #1's RTF
  const loadMs = performance.now() - loadStart;
  const selected = selectedTasks();

  let taskNumber = 0;
  for (const base of BENCH_FILES) {
    for (const recordingType of BENCH_RECORDING_TYPES) {
      if (selected && !selected.has(`${recordingType}:${base}`)) continue;
      if (taskNumber++ > 0) await new Promise((resolve) => setTimeout(resolve, BENCH_PAUSE_MS));

      const audioPath = path.join(TEST_MEDIA_DIR, `${base}.mp3`);
      if (!fs.existsSync(audioPath)) {
        emit({ kind: 'file', file: base, recordingType, error: `audio yok: ${audioPath}`, config: configSnapshot() });
        continue;
      }

      try {
        // Audio duration for RTF (decoded outside the timed region).
        const pcm = await loadAudio(audioPath);
        const durationSec = pcm.length / SAMPLE_RATE;
        const t0 = performance.now();
        let segments: Segment[];

        if (recordingType === 'static') {
          ({ segments } = await transcribe(audioPath));
        } else {
          const live = getLiveConfig();
          const liveSegments: Segment[] = [];
          const queue = new ChunkQueue({
            language: 'tr',
            onSegments: (delta) => liveSegments.push(...delta),
          });
          const sliceSamples = Math.round(live.chunkSeconds * SAMPLE_RATE);
          for (let i = 0; i < pcm.length; i += sliceSamples) {
            queue.push(pcm.subarray(i, i + sliceSamples));
            await queue.settle();
          }
          await queue.drain();
          segments = flagBoundaryOrphans(liveSegments);
          // Keep the live path's speaker behavior aligned with the application. No gate:
          // diarize() returns null unless the app enabled it, so this is a no-op by default.
          const { diarize } = await import('../diarize/diarizer.ts');
          const { assignSpeakers } = await import('../transcribe/align.ts');
          const diarization = await diarize(audioPath);
          if (diarization) segments = assignSpeakers(segments, diarization);
        }

        const ms = performance.now() - t0;
        emit({
          kind: 'file',
          file: base,
          recordingType,
          durationSec,
          ms,
          text: segmentsToDialogue(segments),
          segments,
          loadMs,
          peakRss,
          config: configSnapshot(),
        });
      } catch (e) {
        emit({ kind: 'file', file: base, recordingType, error: e instanceof Error ? e.message : String(e), config: configSnapshot() });
      }
    }
  }

  clearInterval(rssTimer);
  emit({ kind: 'done', config: configSnapshot(), loadMs, peakRss });
}

main().catch((e) => {
  clearInterval(rssTimer);
  console.error(`[bench-worker] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
