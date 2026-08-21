import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  diarizeWithStats,
  parseDiarizationResult,
  parseDiarizationStats,
} from '../diarize/diarizer.ts';
import {
  configureDiarization,
  DEFAULT_DIARIZATION_DEVICE,
  getDiarizationConfig,
  PYANNOTE_MODEL_VERSION,
  PYANNOTE_PROVIDER,
} from '../diarization-config.ts';

function readWorker(): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', 'diarize', 'pyannote-worker.py'), 'utf8');
}

describe('Pyannote worker protocol', () => {
  it('accepts the marker line amid worker output', () => {
    assert.deepEqual(
      parseDiarizationResult('loading…\n__DIAR_RESULT__[{"start":0,"end":1.25,"speaker":"SPEAKER_00"}]\n'),
      [{ start: 0, end: 1.25, speaker: 'SPEAKER_00' }],
    );
  });

  it('rejects missing, malformed, and unsafe output', () => {
    assert.equal(parseDiarizationResult('no result'), null);
    assert.equal(parseDiarizationResult('__DIAR_RESULT__not-json'), null);
    assert.deepEqual(parseDiarizationResult('__DIAR_RESULT__[{"start":"x","end":1,"speaker":"S"}]'), []);
  });

  it('passes the application WAV as an in-memory waveform, not through TorchCodec', () => {
    const worker = readWorker();
    assert.match(worker, /TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD/);
    assert.match(worker, /wave\.open\(audio_path/);
    assert.match(worker, /audio = load_recorded_wav\(audio_path\)/);
    assert.match(worker, /pipeline\(audio\)/);
    assert.doesNotMatch(worker, /pipeline\(audio_path\)/);
  });

  // The pipeline's own 10s-window labelling collapses short alternating meetings to a
  // single speaker, so the worker re-clusters 1.5s windows through Community-1's PLDA.
  // That path is best-effort: its failure must leave the pipeline's labels standing.
  it('re-clusters short windows but keeps the pipeline labels as a fallback', () => {
    const worker = readWorker();
    assert.match(worker, /cluster_vbx/);
    assert.match(worker, /turns = pipeline_turns\(annotation\)/);
    const guarded = worker.slice(worker.indexOf('turns = pipeline_turns(annotation)'));
    assert.match(guarded, /try:[\s\S]*cluster_windows[\s\S]*except Exception/);
  });
});

describe('Diarization device selection', () => {
  // The product is GPU-only: CPU took 11.7 min on a 24.5 min meeting against 1.0 min on a
  // GPU, so the app must never land on it by omission.
  it('defaults to cuda and normalizes a config that omits the device', () => {
    const previous = getDiarizationConfig();
    try {
      configureDiarization({
        enabled: true,
        provider: PYANNOTE_PROVIDER,
        pythonPath: 'python',
        modelDir: 'models',
        modelVersion: PYANNOTE_MODEL_VERSION,
      });
      assert.equal(getDiarizationConfig().device, DEFAULT_DIARIZATION_DEVICE);
      assert.equal(DEFAULT_DIARIZATION_DEVICE, 'cuda');

      configureDiarization({ ...getDiarizationConfig(), device: 'cpu' });
      assert.equal(getDiarizationConfig().device, 'cpu');
    } finally {
      configureDiarization(previous);
    }
  });

  it('takes the device as an optional fourth argument so the old two-arg call still runs', () => {
    const worker = readWorker();
    assert.match(worker, /len\(sys\.argv\) not in \(3, 4\)/);
    assert.match(worker, /requested = sys\.argv\[3\] if len\(sys\.argv\) == 4 else "cpu"/);
  });

  // Strict 'cuda' is the product mode: no GPU means fail, so the parent finishes the
  // transcript without speakers. A silent CPU fallback would instead hand the user an
  // 11-minute wait that reads as a hang. 'auto' keeps the lenient path for diarize-bench.
  it('fails under strict cuda but falls back to cpu under auto', () => {
    const worker = readWorker();
    const resolver = worker.slice(worker.indexOf('def resolve_device'), worker.indexOf('def clock'));
    assert.match(resolver, /if torch\.cuda\.is_available\(\):[\s\S]*return torch\.device\("cuda"\)/);
    assert.match(resolver, /if requested == "cuda":\s*\n\s*raise RuntimeError/);
    assert.match(resolver, /return torch\.device\("cpu"\), reason/);
  });

  it('rescues an OOM on cpu only for auto, never for strict cuda', () => {
    const worker = readWorker();
    assert.match(
      worker,
      /except torch\.cuda\.OutOfMemoryError as error:\s*\n\s*if device\.type != "cuda" or stats\["requested"\] != "auto":\s*\n\s*raise/,
    );
    assert.match(worker, /run_diarization\(audio, model_dir, device, stats\)/);
  });

  // The coarse pass embeds every window of the meeting in one stack. That is fine in RAM
  // and fatal in 8 GB of VRAM, so CUDA must slice while CPU keeps the single stack its
  // existing measurements were taken with.
  it('slices the embedding batch on cuda only', () => {
    const worker = readWorker();
    const sizer = worker.slice(worker.indexOf('def embed_batch_size'), worker.indexOf('def run_embedder'));
    assert.match(sizer, /!= "cuda":\s*\n\s*return total/);
    assert.match(sizer, /ENGINE_DIARIZE_EMBED_BATCH/);
    assert.match(worker, /except torch\.cuda\.OutOfMemoryError:[\s\S]*batch \/\/ 2/);
  });

  it('synchronizes before every timing so async kernels are not timed as instant', () => {
    const worker = readWorker();
    const timer = worker.slice(worker.indexOf('def clock'), worker.indexOf('def peak_rss_mb'));
    assert.match(timer, /if device\.type == "cuda":\s*\n\s*torch\.cuda\.synchronize\(\)/);
  });
});

describe('Diarization stats line', () => {
  it('reads the stats marker independently of the result marker', () => {
    const stdout = 'loading…\n__DIAR_STATS__{"device":"cuda","totalMs":41234,"peakVramMB":812.5}\n'
      + '__DIAR_RESULT__[{"start":0,"end":1.25,"speaker":"SPEAKER_00"}]\n';
    assert.deepEqual(parseDiarizationStats(stdout), { device: 'cuda', totalMs: 41234, peakVramMB: 812.5 });
    assert.deepEqual(parseDiarizationResult(stdout), [{ start: 0, end: 1.25, speaker: 'SPEAKER_00' }]);
  });

  // An older worker emits no stats line at all; that is missing data, not a failure.
  it('returns null for missing, malformed, or non-object stats', () => {
    assert.equal(parseDiarizationStats('__DIAR_RESULT__[]'), null);
    assert.equal(parseDiarizationStats('__DIAR_STATS__not-json'), null);
    assert.equal(parseDiarizationStats('__DIAR_STATS__[1,2]'), null);
  });

  it('emits the stats line the benchmark reads', () => {
    const worker = readWorker();
    assert.match(worker, /STATS_MARKER = "__DIAR_STATS__"/);
    for (const field of ['totalMs', 'pipelineMs', 'embedMs', 'refineMs', 'peakVramMB', 'peakRssMB', 'fellBack']) {
      assert.match(worker, new RegExp(`"${field}"`), `stats alanı eksik: ${field}`);
    }
  });
});

describe('Diarization cancellation', () => {
  // The kill of a RUNNING worker needs a real Pyannote install, so it is verified by
  // hand against a live recording (CLAUDE.md's manual step). What is checked here is
  // the cheaper half of the same contract: an already-cancelled meeting must not spawn
  // a worker at all — the pre-check is what keeps a cancel during the ASR drain from
  // still paying for a GPU pass on its way out.
  it('does not spawn a worker when the signal is already aborted', async () => {
    const config = {
      enabled: true,
      provider: PYANNOTE_PROVIDER,
      // Real paths, so isReady() passes and the abort guard is the only thing that can
      // stop it. Anything spawned with these would fail loudly rather than silently.
      pythonPath: process.execPath,
      modelDir: path.resolve(import.meta.dirname, '..', 'diarize'),
      device: DEFAULT_DIARIZATION_DEVICE,
    };

    const run = await diarizeWithStats('missing.wav', 1000, config, AbortSignal.abort());

    assert.deepEqual(run, { segments: null, stats: null });
  });
});
