// Single source of truth for the model benchmark: the config matrix, the test
// files, the dtype->ONNX-filename resolution, and the output paths.
// download-models, check-models, bench/run and the manual tools ALL import from
// here so a dtype can't be downloaded under one interpretation, checked under
// another, and run under a third (see docs/model-selection.md).
//
// Pure config + path logic. It reuses parseDtype from models.ts (the one parser)
// but does no model loading itself. Which output is the REFERENCE for a scenario
// is a separate concern — see control-group.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODELS_DIR } from '../diarization-config.ts';
import { getConfig, parseDtype, type Dtype, type TranscribeMode } from '../models.ts';

// engine/bench -> engine -> <root>
export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const OUTPUT_BENCH_DIR = path.join(OUTPUT_DIR, 'bench');
export const BENCH_LOCK_PATH = path.join(OUTPUT_BENCH_DIR, '.bench.lock');
export const OUTPUT_TEST_RUN_DIR = path.join(OUTPUT_DIR, 'test_run');
// The control group is a SEPARATE top-level folder, not under output/, because its lifetime
// is different: output/ holds throwaway runs, control-group/ holds promoted judgements. Only
// the Markdown registry is shared — the reference JSONs are git-ignored (real meeting
// transcripts), so a fresh clone legitimately has none and every metric reports n/a.
// Registry rows resolve relative to this dir (control-group.ts).
export const CONTROL_GROUP_DIR = path.join(ROOT, 'control-group');
export const CONTROL_GROUP_MD = path.join(CONTROL_GROUP_DIR, 'control-group.md');
export const TEST_MEDIA_DIR = path.join(ROOT, 'test_media');

// Timestamped run-directory name, shared by bench and the manual tool so both produce
// the same on-disk shape (and control-group.md can point at either).
export function runStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export interface BenchConfig {
  id: string;
  model: string;
  dtype: string; // raw ENGINE_DTYPE string (scalar or "encoder=q8,decoder=fp32")
  mode: TranscribeMode;
}

const MEDIUM = 'onnx-community/whisper-medium-ONNX';
const TURBO = 'onnx-community/whisper-large-v3-turbo';

// A = current default (baseline, already downloaded). B-D probe turbo. The brief's
// row E ("winner of B-D, sequential") is decided after turbo runs, so it is added
// by the user round, not predefined here.
export const BENCH_MATRIX: BenchConfig[] = [
  { id: 'A_medium_q8_chunked', model: MEDIUM, dtype: 'q8', mode: 'chunked' },
  { id: 'B_turbo_q8_chunked', model: TURBO, dtype: 'q8', mode: 'chunked' },
  { id: 'C_turbo_encq8_decfp32', model: TURBO, dtype: 'encoder=q8,decoder=fp32', mode: 'chunked' },
  { id: 'D_turbo_fp32_chunked', model: TURBO, dtype: 'fp32', mode: 'chunked' },
];

// Every scenario in test_media/, in ascending cost order — S8 (~45 min of audio) last so
// a bench that dies late still has the cheap scenarios on disk. The bench is now the only
// measurement system, so it covers everything rather than a near-mic subset; per-file
// streaming in worker.ts is what makes a run this long survivable (see run.ts).
export const BENCH_FILES = [
  'S1-C', 'S1-F', 'S2-C', 'S2-F', 'S3-F', 'S4-C', 'S5-C', 'S6-C',
  'S7-A', 'S7-B', 'S7-C', 'S7-D', 'S7-E',
  'S8',
];

export const BENCH_RECORDING_TYPES = ['static', 'live'] as const;
export type BenchRecordingType = (typeof BENCH_RECORDING_TYPES)[number];
export const BENCH_TASK_COUNT = BENCH_FILES.length * BENCH_RECORDING_TYPES.length * BENCH_MATRIX.length;

// Marker the bench worker prefixes its single JSON result line with, so the parent can
// pick it out of ORT/progress chatter (same trick as the diarizer). Lives here so the
// parent never imports the self-executing worker just to know the constant.
export const BENCH_RESULT_MARKER = '__BENCH_RESULT__';

// Per-scenario domain-term checklist (the accuracy signal — turbo is expected to win
// here per analysis §4). Best-effort subsets of the brief's global term list, drawn from
// where each term actually occurs in docs/test-materials.md.
//
// -C/-F are the same script at different mic distances, so they share a list — that's the
// point of the pair: identical terms, different acoustics.
//
// S7-* (micro edge cases) and S8 (a real 40-min meeting) have NO fixed script, so no term
// list. domainRecall returns 0/0 for them and the signal comes from duplicate/overlap/
// hallucination counts instead. An empty list is deliberate, not an oversight.
export const DOMAIN_TERMS: Record<string, string[]> = {
  'S1-C': ['numune', 'boyahane', 'termin', 'sevkiyat'],
  'S1-F': ['numune', 'boyahane', 'termin', 'sevkiyat'],
  'S2-C': ['fire', 'boyahane', 'numune', 'fason'],
  'S2-F': ['fire', 'boyahane', 'numune', 'fason'],
  'S3-F': ['fason', 'ekru', 'termin', 'numune'],
  'S4-C': ['brief', 'deadline', 'feedback', 'cost', 'compliance', 'concern'],
  'S5-C': ['Gülşah', 'Cüneyt', 'Zeynep', 'Öztürk', 'iskonto', 'sevkiyat'],
  'S6-C': ['fason', 'hukuk', 'leasing', 'peşinat', 'ilan', 'Cüneyt'],
};

// Transformers.js dtype -> filename suffix (DEFAULT_DTYPE_SUFFIX_MAPPING).
const DTYPE_SUFFIX: Record<Dtype, string> = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4' };

// Resolve the two ONNX files Transformers.js will request for (modelId, dtype).
// Split dtype picks a suffix per sub-model; a missing side defaults to fp32 (the
// Transformers.js default). Paths follow the on-disk cache layout models/<id>/onnx/.
export function expectedWhisperFiles(modelId: string, dtypeStr: string): { encoder: string; decoder: string } {
  const parsed = parseDtype(dtypeStr);
  const encDtype: Dtype = typeof parsed === 'string' ? parsed : parsed.encoder_model ?? 'fp32';
  const decDtype: Dtype = typeof parsed === 'string' ? parsed : parsed.decoder_model_merged ?? 'fp32';
  const onnxDir = path.join(MODELS_DIR, modelId, 'onnx');
  return {
    encoder: path.join(onnxDir, `encoder_model${DTYPE_SUFFIX[encDtype]}.onnx`),
    decoder: path.join(onnxDir, `decoder_model_merged${DTYPE_SUFFIX[decDtype]}.onnx`),
  };
}

// A .onnx smaller than this keeps its weights in an external `<file>_data` sidecar
// (turbo's fp32 encoder is 439 KB + a ~2.37 GB .onnx_data). Both files are required.
const EXTERNAL_DATA_THRESHOLD = 1024 * 1024;

// Which ONNX files (modelId, dtype) requires on disk, and which are missing —
// including the external-data sidecar when the resolved .onnx is a tiny stub. Shared
// by download-models (idempotency: skip when nothing missing) and check-models
// (fail when something is missing). No hardcoded model names.
export function whisperFileStatus(modelId: string, dtypeStr: string): { required: string[]; missing: string[] } {
  const { encoder, decoder } = expectedWhisperFiles(modelId, dtypeStr);
  const required: string[] = [];
  const missing: string[] = [];
  for (const f of [encoder, decoder]) {
    required.push(f);
    if (!fs.existsSync(f)) {
      missing.push(f);
      continue;
    }
    if (fs.statSync(f).size < EXTERNAL_DATA_THRESHOLD) {
      const dataFile = `${f}_data`; // encoder_model.onnx -> encoder_model.onnx_data
      required.push(dataFile);
      if (!fs.existsSync(dataFile)) missing.push(dataFile);
    }
  }
  return { required, missing };
}

// Dedupe a config list down to the distinct (model, dtype) pairs that actually need
// downloading — several matrix rows can share weights (e.g. B and C share the q8 encoder).
export function uniqueModelDtypePairs(configs: BenchConfig[]): { model: string; dtype: string }[] {
  const seen = new Set<string>();
  const out: { model: string; dtype: string }[] = [];
  for (const c of configs) {
    const key = `${c.model}|${c.dtype}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ model: c.model, dtype: c.dtype });
  }
  return out;
}

// Bench-style file-name id for a (model, dtype, mode) config. If the config is one of
// the matrix rows, reuse that row's id ("B_turbo_q8_chunked") so manual-tool output lines
// up with bench output; otherwise derive a filesystem-safe slug ("<modelShort>_<dtype>_<mode>",
// with '='/',' from split dtype flattened). Shared so the manual tool names files the same
// way the bench does. `dtype` is the RAW ENGINE_DTYPE string (configSnapshot().dtype).
export function benchStyleId(model: string, dtype: string, mode: string): string {
  const hit = BENCH_MATRIX.find((c) => c.model === model && c.dtype === dtype && c.mode === mode);
  if (hit) return hit.id;
  const short = model.split('/').pop()!.replace(/^whisper-/, '').replace(/-ONNX$/i, '');
  return `${short}_${dtype.replace(/[=,]/g, '-')}_${mode}`;
}

// The (model, dtype) pairs download-models/check-models act on. Default (env unset):
// BOTH production models — the configured one and the foreign-language one, since a
// meeting recorded as "Yabancı dil" loads the second and an installer that shipped
// without it would fail at the worst possible moment. `=bench` expands to the whole
// matrix; "model:dtype,model:dtype" is an explicit list. Model ids contain '/', so each
// entry splits on its LAST ':'.
export function resolveDownloadPairs(): { model: string; dtype: string }[] {
  const spec = process.env.ENGINE_DOWNLOAD_MATRIX?.trim();
  if (!spec) {
    const config = getConfig();
    const dtype = process.env.ENGINE_DTYPE || 'q8';
    // The foreign model is published quantized-only, so it is always fetched at q8
    // regardless of what the Turkish path is configured with.
    return [
      { model: config.modelId, dtype },
      { model: config.foreignModelId, dtype: 'q8' },
    ];
  }
  if (spec === 'bench') return uniqueModelDtypePairs(BENCH_MATRIX);
  return spec.split(',').map((part) => {
    const idx = part.lastIndexOf(':');
    if (idx < 0) throw new Error(`Geçersiz ENGINE_DOWNLOAD_MATRIX parçası "${part}". Biçim: model:dtype`);
    return { model: part.slice(0, idx).trim(), dtype: part.slice(idx + 1).trim() };
  });
}
