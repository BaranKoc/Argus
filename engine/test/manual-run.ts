// npm run test-run — the manual test tool: ONE scenario, transcribe and/or analyze.
//
// Effectively a single-file bench. It writes the SAME JSON schema into the same shape of
// timestamped run directory (output/test_run/<stamp>/{transcribe,analyze}/) and computes
// metrics with the same bench/metrics.ts functions. That symmetry is the whole point:
// control-group/control-group.md can name a promoted output as a scenario's
// reference without the reader caring which produced it.
//
// WHY THIS REPLACED manual-transcribe/manual-analyze: those wrote incremental saves
// (S1-C.json, S1-C_1.json …) into output/transcriber/, the very folder that also served
// as the control group — forcing throwaway output and trusted baselines to share one lifecycle.
// Runs now land in
// their own dated folder and are never deleted; being the reference is a separate,
// explicit act (a row in control-group.md).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

import { transcribe, segmentsToDialogue, analyze, warmUp, configureDiarization, type Transcript } from '../index.ts';
import { MODELS_DIR, PYANNOTE_MODEL_VERSION, PYANNOTE_PROVIDER } from '../diarization-config.ts';
import { configSnapshot, getConfig, getLiveConfig, llmSnapshot, SAMPLE_RATE } from '../models.ts';
import { loadAudio } from '../transcribe/audio.ts';
import { ChunkQueue } from '../live/chunk-queue.ts';
import { finalize, labelSpeakers, computeDiarizeTimeoutMs } from '../live/finalize.ts';
import {
  benchStyleId,
  runStamp,
  whisperFileStatus,
  DOMAIN_TERMS,
  CONTROL_GROUP_DIR,
  OUTPUT_DIR,
  OUTPUT_TEST_RUN_DIR,
  TEST_MEDIA_DIR,
} from '../bench/matrix.ts';
import { controlGroupText, resolveControlGroup } from '../bench/control-group.ts';
import { buildMetrics, formatMetricLine, metricsTableRow, METRICS_TABLE_HEADER } from '../bench/metrics.ts';
import { ask, closeAsk, writeJson, writeMonoPcm16Wav } from './manual-utils.ts';
import {
  speakerReport,
  dialogueLines,
  formatSpeakerLine,
  speakerTableRow,
  SPEAKER_TABLE_HEADER,
} from './speaker-report.ts';
import type { Segment } from '../transcribe/transcriber.ts';

type Stage = 'transcribe' | 'analyze' | 'both' | 'live' | 'live-transcribe';

interface PyannotePaths {
  pythonPath: string;
  modelDir: string;
}

// Where `npm run download-pyannote -w engine` puts the developer install. Defaulting to
// it is what lets the speaker stages be one command instead of a command plus two long
// paths; the --pyannote-* flags stay as an override for an install kept elsewhere.
const DEFAULT_PYANNOTE_PYTHON = path.join(
  MODELS_DIR,
  'pyannote',
  'runtime',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const DEFAULT_PYANNOTE_MODEL_DIR = path.join(MODELS_DIR, 'pyannote', PYANNOTE_MODEL_VERSION);

// Resolve the install WITHOUT touching it — returns null when nothing is there, so the
// caller can offer the choice rather than exploding on a machine that never ran the
// download. A half-given flag pair is still an error: that is a typo, not an absence.
function resolvePyannotePaths(): PyannotePaths | null {
  const args = process.argv.slice(2);
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const pythonFlag = valueAfter('--pyannote-python');
  const modelFlag = valueAfter('--pyannote-model-dir');
  const pyannoteFlags = args.filter((arg) => arg.startsWith('--pyannote-'));
  if (pyannoteFlags.length > 0 && (!pythonFlag || !modelFlag)) {
    throw new Error('Pyannote yolu verilecekse hem --pyannote-python hem --pyannote-model-dir gerekir.');
  }
  const pythonPath = pythonFlag ?? DEFAULT_PYANNOTE_PYTHON;
  const modelDir = modelFlag ?? DEFAULT_PYANNOTE_MODEL_DIR;
  // An explicitly-flagged path that does not exist is a mistake worth reporting; a
  // missing DEFAULT just means this machine has no install yet.
  if (!fs.existsSync(pythonPath) || !fs.existsSync(path.join(modelDir, 'config.yaml'))) {
    if (pythonFlag || modelFlag) {
      throw new Error(`Pyannote kurulumu verilen yolda yok: ${pythonPath} / ${modelDir}`);
    }
    return null;
  }
  return { pythonPath, modelDir };
}

function enableDiarization({ pythonPath, modelDir }: PyannotePaths): void {
  try {
    execFileSync(pythonPath, ['-c', 'import pyannote.audio'], { stdio: 'ignore', windowsHide: true });
  } catch {
    throw new Error(`Pyannote paketi bu ortamda kurulu değil: ${pythonPath}. "npm run download-pyannote -w engine" ile tamamlayın.`);
  }
  configureDiarization({
    enabled: true,
    provider: PYANNOTE_PROVIDER,
    pythonPath,
    modelDir,
    modelVersion: PYANNOTE_MODEL_VERSION,
  });
  console.log(`[test-run] Pyannote etkin: ${modelDir}`);
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Prompt for test_media/ filename(s), showing what's available on a miss rather than
// making the developer guess at the spelling. A comma-separated list is accepted so the
// speaker stage can sweep several scenarios in ONE process — one warmUp, one run folder,
// one comparison table. Every other stage takes the first name only.
//
// The synthetic analyze fixtures (S9, S10) have no audio at all; their control-group row carries
// a generated, frozen transcript input and nothing else. A miss is therefore not necessarily
// an error: a SINGLE typed
// name whose base has a control-group transcribe reference continues as analyze-only (empty
// audioNames) instead of exiting. A miss inside a multi-name sweep still is an error — there
// is no audio to sweep.
async function askAudioFiles(): Promise<{ audioNames: string[]; base: string }> {
  const answer = await ask('Dosya (test_media/, örn. S1-C.mp3 — virgülle birden fazla; yalnız analiz için S9/S10): ');
  if (!answer) throw new Error('Dosya adı verilmedi.');
  const names = answer.split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('Dosya adı verilmedi.');
  const missing = names.filter((n) => !fs.existsSync(path.join(TEST_MEDIA_DIR, n)));
  if (missing.length === 0) return { audioNames: names, base: path.parse(names[0]!).name };

  const base = path.parse(names[0]!).name;
  if (names.length === 1 && resolveControlGroup(base, 'transcribe')) {
    console.log(`\n"${names[0]}" test_media/ altında yok, ama "${base}" için control-group transcribe kaydı var — yalnız analiz olarak devam ediliyor.`);
    return { audioNames: [], base };
  }
  const available = listDir(TEST_MEDIA_DIR);
  console.error(`\nBulunamadı: ${missing.join(', ')} (control-group'ta transcribe referansı da yok). test_media/ içindekiler:`);
  console.error(available.length ? available.map((f) => `  - ${f}`).join('\n') : '  (klasör boş)');
  process.exit(1);
}

// Stage [5] IS the speaker test, so it defaults to ON; every other stage defaults to OFF
// — that is the switch position every control-group reference was produced under, so an
// accidental "yes" can't silently make a run incomparable to its reference.
async function askDiarization(stage: Stage, paths: PyannotePaths | null): Promise<boolean> {
  if (stage === 'analyze') return false; // no audio is transcribed, so nothing to diarize
  if (!paths) {
    if (stage === 'live-transcribe') {
      throw new Error('live-transcribe aşaması Pyannote gerektirir. "npm run download-pyannote -w engine" ile kurun.');
    }
    console.log('\nPyannote kurulu değil — konuşmacı ayrımı olmadan devam ediliyor.');
    return false;
  }
  const fallback = stage === 'live-transcribe' ? 'e' : 'h';
  const answer = await ask(`Pyannote ile konuşmacı ayrımı? [e/h] (varsayılan ${fallback}): `);
  const enabled = (answer.trim().toLowerCase() || fallback) === 'e';
  if (enabled) enableDiarization(paths);
  return enabled;
}

type Operation = 'transcribe' | 'analyze' | 'both';
type Mode = 'static' | 'live';

async function askOperation(): Promise<Operation> {
  const answer = await ask('İşlem? [1] transcribe [2] analyze [3] ikisi (varsayılan 3): ');
  const choice = answer || '3';
  const map: Record<string, Operation> = { '1': 'transcribe', '2': 'analyze', '3': 'both' };
  const operation = map[choice];
  if (!operation) throw new Error(`Geçersiz işlem "${choice}". 1-3 arası bekleniyordu.`);
  return operation;
}

// analyze never touches audio (it reads an existing transcript), so live/static has no
// meaning for it — skip straight past, same as the diarization question already does.
async function askMode(): Promise<Mode> {
  const answer = await ask(
    'Nasıl? [1] statik (dosyanın tamamı) [2] canlı (ChunkQueue simülasyonu) (varsayılan 1): ',
  );
  const choice = answer || '1';
  const map: Record<string, Mode> = { '1': 'static', '2': 'live' };
  const mode = map[choice];
  if (!mode) throw new Error(`Geçersiz mod "${choice}". 1-2 arası bekleniyordu.`);
  return mode;
}

async function askStage(): Promise<Stage> {
  const operation = await askOperation();
  if (operation === 'analyze') return 'analyze';
  const mode = await askMode();
  if (operation === 'transcribe') return mode === 'live' ? 'live-transcribe' : 'transcribe';
  return mode === 'live' ? 'live' : 'both';
}

// Where analyze-only reads its transcript from. Default = this scenario's control-group
// transcribe row, so an analyzer change is testable without paying to transcribe again.
async function askSourceTranscript(base: string): Promise<string> {
  const fromRegistry = resolveControlGroup(base, 'transcribe');
  // Default = the control-group reference (shown control-group/-relative). A typed override
  // is still resolved against output/, since that's where a fresh test_run transcript lives.
  const hint = fromRegistry
    ? `[enter = control group: control-group/${path.relative(CONTROL_GROUP_DIR, fromRegistry).replace(/\\/g, '/')}]`
    : '(bu senaryonun control-group kaydı yok — yol zorunlu)';
  const answer = await ask(`Kaynak transkript, output/'a göre (ya da enter) ${hint}: `);
  if (!answer) {
    if (!fromRegistry) throw new Error(`"${base}" için control-group transcribe kaydı yok; yol vermelisin.`);
    return fromRegistry;
  }
  const abs = path.resolve(OUTPUT_DIR, answer);
  if (!fs.existsSync(abs)) throw new Error(`Bulunamadı: ${abs}`);
  return abs;
}

// Same acceptance order as the old manual-analyze: prefer the joined text, fall back to
// the Transcript envelope, last resort a raw string.
function toAnalyzeInput(parsed: unknown): string | Transcript {
  if (typeof parsed === 'string') return parsed;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text === 'string' && obj.text.trim().length > 0) return obj.text;
  if (Array.isArray(obj.segments)) return { status: 'success', segments: obj.segments } as Transcript;
  throw new Error('Dosyada analiz edilecek metin (text/segments) bulunamadı.');
}

function configDiskBytes(): number {
  const snapshot = configSnapshot();
  return whisperFileStatus(snapshot.model, snapshot.dtype).required.reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);
}

async function runTranscribe(
  audioName: string,
  base: string,
  outPath: string,
): Promise<{ text: string; segments: Segment[]; metrics: Record<string, unknown> }> {
  const audioPath = path.join(TEST_MEDIA_DIR, audioName);

  // Mirror bench/worker.ts's measurement exactly, or a test_run row and a bench row would
  // not be comparable even though they share a schema:
  //   - warmUp() first, so model load is NOT folded into the transcribe timing (rtf).
  //   - loadMs means MODEL load time (not audio decode).
  //   - peakRss is sampled, not a single end-of-run snapshot.
  // Audio is decoded outside the timed region, again as the worker does.
  let peakRss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 200);

  console.log('\nModel yükleniyor…');
  const loadStart = performance.now();
  await warmUp();
  const loadMs = performance.now() - loadStart;

  const durationSec = (await loadAudio(audioPath)).length / SAMPLE_RATE;

  console.log('Çevriliyor…');
  const t0 = performance.now();
  const { segments } = await transcribe(audioPath);
  const ms = performance.now() - t0;
  clearInterval(rssTimer);
  const text = segmentsToDialogue(segments);

  const metrics = buildMetrics(
    { text, segments, durationSec, ms, loadMs, peakRss, diskBytes: configDiskBytes() },
    controlGroupText(base),
    DOMAIN_TERMS[base] ?? [],
  );

  writeJson(outPath, { config: configSnapshot(), file: base, recordingType: 'static', outputType: 'transcribe', metrics, text, segments });
  console.log(`  ${base}: ${formatMetricLine(base, metrics)}`);
  if (metrics.referencePath == null) {
    console.log('  (referans yok — wer/halüsinasyon n/a. control-group.md\'de bu satır boş demektir.)');
  }
  return { text, segments, metrics };
}

// Feed decoded PCM through a real ChunkQueue in synthetic chunkSeconds slices, exactly as
// the recorder would. Shared by stage [4] and stage [5] so the two measure the same path.
//
// Settle after each push so every slice becomes its own round with the previous round's
// tail prepended — the faithful real-time model (chunks arrive ~chunkSeconds apart, so a
// round finishes before the next slice lands). settle() (not drain()) honors the first-round
// hold, so the opening still accrues firstChunkSeconds of audio before decoding, exactly as
// the live recorder would; the final drain() flushes whatever's left. Pushing all slices at
// once would instead let the queue COALESCE them into a couple of big rounds, exercising
// only one seam and hiding the per-slice rolling-window behavior these stages test.
async function simulateLive(
  pcm: Float32Array,
  chunkSeconds: number,
): Promise<{ segments: Segment[]; ms: number }> {
  console.log('Canlı simülasyon (ChunkQueue, dilim dilim)…');
  const segments: Segment[] = [];
  const queue = new ChunkQueue({
    language: 'tr',
    onSegments: (delta) => segments.push(...delta),
  });

  const sliceSamples = Math.round(chunkSeconds * SAMPLE_RATE);
  const t0 = performance.now();
  for (let i = 0; i < pcm.length; i += sliceSamples) {
    queue.push(pcm.subarray(i, i + sliceSamples));
    await queue.settle();
  }
  await queue.drain();
  return { segments, ms: performance.now() - t0 };
}

// Stage [5]: the live path stopped one step short of analysis — ChunkQueue simulation, then
// the real labelSpeakers() (diarize + assignSpeakers + boundary orphans). Its whole purpose is
// blind speaker identification, so it computes NO bench metrics and reads NO control group:
// every promoted reference was produced with diarization off and carries no speaker labels, so
// there is nothing there to compare against. The verdict is the speaker report plus the
// human-readable dialogue dump.
async function runLiveTranscribe(
  audioName: string,
  base: string,
  runDir: string,
): Promise<{ report: ReturnType<typeof speakerReport>; audioSec: number } | null> {
  const audioPath = path.join(TEST_MEDIA_DIR, audioName);
  const live = getLiveConfig();

  const pcm = await loadAudio(audioPath);
  const durationSec = pcm.length / SAMPLE_RATE;
  console.log(`\n=== ${base} ===  ses: ${durationSec.toFixed(1)}s  chunk: ${live.chunkSeconds}s`);

  const { segments: liveSegments, ms: liveMs } = await simulateLive(pcm, live.chunkSeconds);

  const wavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-live-wav-'));
  const wavPath = path.join(wavDir, 'recording.wav');
  writeMonoPcm16Wav(wavPath, pcm, SAMPLE_RATE);

  console.log('Konuşmacı ayrımı (Pyannote)…');
  const diarizeStart = performance.now();
  let labelled: Awaited<ReturnType<typeof labelSpeakers>>;
  try {
    labelled = await labelSpeakers(liveSegments, wavPath, {
      diarizeTimeoutMs: computeDiarizeTimeoutMs(durationSec * 1000),
    });
  } finally {
    fs.rmSync(wavDir, { recursive: true, force: true });
  }
  const diarizeMs = performance.now() - diarizeStart;

  const report = speakerReport(labelled.segments);
  const text = segmentsToDialogue(labelled.segments);

  writeJson(path.join(runDir, `${base}_live-transcribe.json`), {
    config: configSnapshot(),
    file: base,
    recordingType: 'live',
    outputType: 'transcribe',
    audioSec: +durationSec.toFixed(1),
    transcribeMs: Math.round(liveMs),
    diarizeMs: Math.round(diarizeMs),
    speakerReport: report,
    speakersDegraded: labelled.speakersDegraded ?? false,
    text,
    segments: labelled.segments,
  });
  fs.writeFileSync(
    path.join(runDir, `${base}_live-dialogue.txt`),
    `${base} — ${audioName} — ${durationSec.toFixed(1)}s\n${'-'.repeat(60)}\n${dialogueLines(labelled.segments)}\n`,
    'utf8',
  );

  console.log(`  ${formatSpeakerLine(base, report)}`);
  if (labelled.speakersDegraded) console.log('  (speakersDegraded — diarization atlandı)');
  return { report, audioSec: durationSec };
}

// Stage [4]: the live-recording pipeline (ChunkQueue rolling window + finalize), as
// opposed to batch transcribe(). It feeds the decoded PCM into a real ChunkQueue in
// synthetic chunkSeconds slices exactly as the recorder would, then runs the real
// finalize() (diarize + analyze). The output is written into the SAME transcribe/ and
// analyze/ folders as a static run and measured with the SAME buildMetrics against the
// control group — the only difference is recordingType:'live' — so a live row is directly
// comparable and can be named in control-group.md like any other.
async function runLive(
  audioName: string,
  base: string,
  transcribeOut: string,
  analyzeOut: string,
): Promise<Record<string, unknown>> {
  const audioPath = path.join(TEST_MEDIA_DIR, audioName);
  const live = getLiveConfig();

  let peakRss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 200);

  console.log('\nModel yükleniyor…');
  const loadStart = performance.now();
  await warmUp();
  const loadMs = performance.now() - loadStart;

  const pcm = await loadAudio(audioPath);
  const durationSec = pcm.length / SAMPLE_RATE;
  console.log(`Ses süresi: ${durationSec.toFixed(1)}s   chunk: ${live.chunkSeconds}s`);

  const { segments: liveSegments, ms: liveMs } = await simulateLive(pcm, live.chunkSeconds);

  // The fixture can be MP3, but production hands finalize the recorder's WAV.
  // Encode the already-decoded live PCM to exercise that same Pyannote contract.
  const wavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-live-wav-'));
  const wavPath = path.join(wavDir, 'recording.wav');
  writeMonoPcm16Wav(wavPath, pcm, SAMPLE_RATE);

  console.log('finalize() (diarize + analiz)…');
  let result: Awaited<ReturnType<typeof finalize>>;
  try {
    result = await finalize(liveSegments, wavPath, {
      diarizeTimeoutMs: computeDiarizeTimeoutMs(durationSec * 1000),
    });
  } finally {
    fs.rmSync(wavDir, { recursive: true, force: true });
  }
  clearInterval(rssTimer);

  const text = segmentsToDialogue(result.segments);
  const metrics = buildMetrics(
    { text, segments: result.segments, durationSec, ms: liveMs, loadMs, peakRss, diskBytes: configDiskBytes() },
    controlGroupText(base, 'live'),
    DOMAIN_TERMS[base] ?? [],
  );

  writeJson(transcribeOut, {
    config: configSnapshot(),
    file: base,
    recordingType: 'live',
    outputType: 'transcribe',
    metrics,
    text,
    segments: result.segments,
  });
  writeJson(analyzeOut, {
    file: base,
    recordingType: 'live',
    outputType: 'analyze',
    analyzer: llmSnapshot(),
    status: 'success',
    analysis: result.analysis,
    speakersDegraded: result.speakersDegraded ?? false,
  });

  console.log(`  ${base}: ${formatMetricLine(base, metrics)}`);
  if (metrics.referencePath == null) {
    console.log('  (referans yok — wer/halüsinasyon n/a. control-group.md\'de bu satır boş demektir.)');
  }
  console.log(`\n--- Analiz ---\n${result.analysis.markdown}`);
  if (result.speakersDegraded) console.log('\n(konuşmacı etiketleri düşük kaliteli — speakersDegraded)');

  return metrics;
}

async function main(): Promise<void> {
  const pyannote = resolvePyannotePaths();
  // All prompting happens up front, then stdin is released — nothing should ask a
  // question after a 45-minute transcribe has started.
  const input = await askAudioFiles();
  const audioNames = input.audioNames;
  const base = input.base;
  // The audio-less analyze fixtures (S9, S10) have nothing to transcribe, so the stage
  // question is pointless — force analyze and skip straight to picking the source transcript.
  const stage = audioNames.length > 0 ? await askStage() : 'analyze';
  const audioName = audioNames[0] ?? null;
  if (audioName == null && stage !== 'analyze') {
    throw new Error(`"${base}" için ses dosyası yok; yalnız [2] analyze desteklenir.`);
  }
  // Asked AFTER the stage, because the stage decides the default answer.
  const diarizationReady = await askDiarization(stage, pyannote);
  const sourceTranscript = stage === 'analyze' ? await askSourceTranscript(base) : null;
  closeAsk();

  const snapshot = configSnapshot();
  const configId = benchStyleId(snapshot.model, snapshot.dtype, snapshot.mode);
  const runDir = path.join(OUTPUT_TEST_RUN_DIR, runStamp());
  const transcribeFileName = `${base}_${stage === 'live' ? 'live-' : ''}transcribe.json`;
  const analyzeFileName = `${base}_${stage === 'live' ? 'live-' : ''}analyze.json`;

  const scenarioLabel = audioNames.length ? audioNames.map((n) => path.parse(n).name).join(', ') : base;
  console.log(`\nSenaryo: ${scenarioLabel}   config: ${configId}   mod: ${getConfig().mode}`);
  console.log(`Çıktı: ${runDir}`);

  // Stage [5] is the speaker test: it writes its own files, computes no bench metrics and
  // returns before the branches below.
  if (stage === 'live-transcribe') {
    // A speaker test with diarization off would quietly produce a speaker-less transcript
    // and read as "0 speakers found" — a misleading pass, not a result. Refuse instead.
    if (!diarizationReady) {
      throw new Error('live-transcribe aşaması Pyannote gerektirir; konuşmacı ayrımı sorusuna "e" yanıtlayın.');
    }
    console.log('\nModel yükleniyor…');
    await warmUp();

    const rows: string[] = [];
    for (const name of audioNames) {
      const scenario = path.parse(name).name;
      const result = await runLiveTranscribe(name, scenario, runDir);
      if (result) rows.push(speakerTableRow(scenario, result.report, result.audioSec));
    }

    fs.writeFileSync(
      path.join(runDir, 'summary.md'),
      [
        `# Live transcribe (konuşmacı ayrımı) — ${path.basename(runDir)}`,
        '',
        `config: \`${configId}\`　provider: \`${snapshot.diarizationProvider}\`　model: \`${snapshot.diarizationModelVersion}\``,
        '',
        'Bu koşu bir feature denemesidir: kontrol grubuna bakılmaz, WER/domain-recall hesaplanmaz.',
        '"beklenen" senaryo betiğinin konuşmacı sayısıdır (docs/test-materials.md).',
        '',
        ...SPEAKER_TABLE_HEADER,
        ...rows,
        '',
        'Diyaloğu gözle okumak için: `<senaryo>_live-dialogue.txt`',
      ].join('\n'),
      'utf8',
    );

    console.log(`\nKaydedildi: ${runDir}`);
    return;
  }

  let metrics: Record<string, unknown> | null = null;
  let text: string | null = null;

  // Live is mutually exclusive with the static stages: it produces both a transcript and
  // an analysis in one pass, so it writes both files itself and skips the branches below.
  // audioName is guaranteed non-null here — the guard above throws before this point for
  // any audio-requiring stage on an audio-less scenario.
  if (stage === 'live') {
    metrics = await runLive(
      audioName!,
      base,
      path.join(runDir, transcribeFileName),
      path.join(runDir, analyzeFileName),
    );
  }

  if (stage === 'transcribe' || stage === 'both') {
    const res = await runTranscribe(audioName!, base, path.join(runDir, transcribeFileName));
    text = res.text;
    metrics = res.metrics;
  }

  if (stage === 'analyze' || stage === 'both') {
    if (text == null) {
      console.log(`Kaynak transkript: ${sourceTranscript}`);
      text = toAnalyzeInput(JSON.parse(fs.readFileSync(sourceTranscript!, 'utf8'))) as string;
    }
    console.log('\nAnaliz ediliyor… (Ollama ilk çağrıda uzun sürebilir)');
    const outPath = path.join(runDir, analyzeFileName);
    try {
      const analysis = await analyze(text);
      writeJson(outPath, { file: base, recordingType: 'static', outputType: 'analyze', analyzer: llmSnapshot(), status: 'success', analysis });
      console.log(`\n--- Analiz ---\n${analysis.markdown}`);
    } catch (e) {
      // Same failure isolation as bench Stage A: a dead Ollama must not discard the
      // transcript we just paid for.
      writeJson(outPath, { file: base, recordingType: 'static', outputType: 'analyze', analyzer: llmSnapshot(), status: 'failed', error: (e as Error).message });
      console.error(`\nAnaliz başarısız: ${(e as Error).message} (transcribe çıktısı korundu)`);
    }
  }

  if (metrics) {
    const promoteHints: string[] = [];
    if (stage === 'transcribe' || stage === 'both' || stage === 'live') {
      promoteHints.push(`\`npm run promote -w engine -- ${path.relative(OUTPUT_DIR, path.join(runDir, transcribeFileName)).replace(/\\/g, '/')}\``);
    }
    if (stage === 'analyze' || stage === 'both' || stage === 'live') {
      promoteHints.push(`\`npm run promote -w engine -- ${path.relative(OUTPUT_DIR, path.join(runDir, analyzeFileName)).replace(/\\/g, '/')}\``);
    }
    const md = [
      `# Test run — ${path.basename(runDir)}`,
      '',
      `Senaryo: \`${base}\` (${audioName})　config: \`${configId}\`　aşama: ${stage}`,
      '',
      'Referans: `control-group/control-group.md`. "wer" = referanstan sapma, mutlak doğruluk değil.',
      '',
      ...METRICS_TABLE_HEADER,
      metricsTableRow(configId, base, metrics),
      '',
      'Bu sonuç referans olmayı hak ediyorsa promote et:',
      ...promoteHints,
    ].join('\n');
    fs.writeFileSync(path.join(runDir, 'summary.md'), md, 'utf8');
  }

  console.log(`\nKaydedildi: ${runDir}`);
}

main().catch((e) => {
  console.error(`\nHata: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
