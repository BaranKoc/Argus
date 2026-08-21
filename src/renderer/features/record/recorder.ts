// Microphone + Windows system-audio capture that produces a 16 kHz mono WAV in the
// renderer AND streams the same mixed PCM chunks for real-time transcription.
//
// We deliberately encode WAV rather than use MediaRecorder's default webm/opus:
// the engine decodes audio with `audio-decode`, which reliably handles WAV, while
// opus-in-webm is not guaranteed to decode and there is no system ffmpeg on PATH
// (architecture doc §4). Whisper wants 16 kHz mono, so the same samples serve both
// the authoritative full-session WAV and the live chunks fed to the engine.
//
// Because that mix is one mono stream, it cannot say whether a voice came from the room
// or from the call. So each chunk also carries a per-source RMS envelope measured before
// the mixdown — cheap enough to be free, and enough for the engine to attribute speakers
// afterwards (engine/live/source-attribution.ts).

import {
  ENVELOPE_FRAME_SAMPLES,
  type SourceEnvelope,
} from '../../../../engine/live/source-envelope.ts';

const TARGET_RATE = 16000;

// The callback returns void during recording (fire-and-forget) but a Promise for the
// final Stop flush, which the caller awaits so the last chunk reaches the engine
// before live:stop.
type ChunkSink = (pcm: Float32Array, envelope: SourceEnvelope) => void | Promise<void>;

export interface RecorderDependencies {
  mediaDevices: Pick<MediaDevices, 'getUserMedia' | 'getDisplayMedia'>;
  createAudioContext: () => AudioContext;
  logger: Pick<Console, 'info' | 'warn'>;
}

export class Recorder {
  private readonly deps: RecorderDependencies;
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private systemStream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private mixBus: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private taps: ChannelMergerNode | null = null;
  // Full session, encoded to WAV at Stop — the authoritative recording.
  private chunks: Float32Array[] = [];
  // Sub-buffer accumulating since the last live emit; flushed to onChunk every
  // chunkSamples worth of audio (sample-count based, so it is robust to callback jitter).
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  // Per-source RMS frames measured alongside the mix, flushed with it. This is what
  // lets the engine say "the room" or "the call" about a segment the mix cannot
  // distinguish (engine/live/source-attribution.ts).
  private pendingMic: number[] = [];
  private pendingSystem: number[] = [];
  private frameFill = 0;
  private micSquares = 0;
  private systemSquares = 0;
  private chunkSamples = 0;
  private onChunk: ChunkSink | null = null;
  // Closed during preparation and pause. The graph can therefore be ready before the
  // engine session starts without leaking opening samples into a non-recording queue.
  private paused = true;
  private shuttingDown = false;

  constructor(deps: Partial<RecorderDependencies> = {}) {
    this.deps = {
      mediaDevices: deps.mediaDevices ?? navigator.mediaDevices,
      createAudioContext:
        deps.createAudioContext ?? (() => new AudioContext({ sampleRate: TARGET_RATE })),
      logger: deps.logger ?? console,
    };
  }

  // Called synchronously from the Start click, before any await, so Chromium still sees
  // a transient user gesture for getDisplayMedia. System capture is best-effort; the
  // microphone remains the required input.
  async acquire(): Promise<void> {
    let systemRequest: Promise<MediaStream>;
    try {
      systemRequest = this.deps.mediaDevices.getDisplayMedia({ audio: true, video: true });
    } catch (error) {
      systemRequest = Promise.reject(error);
    }

    let micRequest: Promise<MediaStream>;
    try {
      micRequest = this.deps.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (error) {
      micRequest = Promise.reject(error);
    }

    const [system, mic] = await Promise.allSettled([systemRequest, micRequest]);

    if (mic.status === 'rejected') {
      if (system.status === 'fulfilled') stopStream(system.value);
      throw mic.reason;
    }

    this.micStream = mic.value;
    this.watchTracks(this.micStream, 'microphone');

    if (system.status === 'fulfilled') {
      system.value.getVideoTracks().forEach((track) => track.stop());
      if (system.value.getAudioTracks().length > 0) {
        this.systemStream = system.value;
        this.watchTracks(this.systemStream, 'system audio');
      } else {
        stopStream(system.value);
        this.deps.logger.warn('[recorder] System audio unavailable; continuing mic-only.');
      }
    } else {
      this.deps.logger.warn('[recorder] System audio unavailable; continuing mic-only.');
    }

    this.deps.logger.info(`[recorder] Capture mode: ${this.systemStream ? 'mic+system' : 'mic-only'}`);
  }

  // Build the graph behind a closed capture gate. begin() opens it only after liveStart
  // succeeds, making capture initialization atomic from the engine's perspective.
  prepare(onChunk: ChunkSink, chunkSeconds: number): void {
    if (!this.micStream) throw new Error('Microphone stream has not been acquired');

    this.onChunk = onChunk;
    this.chunkSamples = Math.round(chunkSeconds * TARGET_RATE);
    this.paused = true;
    this.shuttingDown = false;
    this.chunks = [];
    this.clearPending();

    this.ctx = this.deps.createAudioContext();
    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.systemSource = this.systemStream
      ? this.ctx.createMediaStreamSource(this.systemStream)
      : null;

    // Force a mono speaker-layout downmix before summing. Unity input gains preserve a
    // quiet mic when system audio is absent; the limiter handles simultaneous peaks.
    this.mixBus = this.ctx.createGain();
    this.mixBus.channelCount = 1;
    this.mixBus.channelCountMode = 'explicit';
    this.mixBus.channelInterpretation = 'speakers';

    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    // One three-channel bundle instead of a second processor: the finished mix on 0 and
    // the two raw sources on 1 and 2 arrive in the SAME callback, so a source frame can
    // never drift against the mix samples it was measured from. The mix path itself is
    // untouched — a merger only routes, so what reaches channel 0 is exactly what the
    // limiter used to hand the processor directly.
    this.taps = this.ctx.createChannelMerger(3);

    // ScriptProcessor is deprecated but universally available and dependency-free;
    // fine for straightforward PCM collection.
    this.node = this.ctx.createScriptProcessor(4096, 3, 1);
    this.node.onaudioprocess = (event) => {
      if (this.paused) return;
      // Copy because the underlying buffer is reused, and clamp the limiter's rare
      // overshoots so live chunks and the final WAV carry identical safe samples.
      const input = event.inputBuffer.getChannelData(0);
      const data = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) data[i] = Math.max(-1, Math.min(1, input[i]));
      this.chunks.push(data);
      this.pending.push(data);
      this.pendingSamples += data.length;
      this.measureSources(event.inputBuffer);
      if (this.pendingSamples >= this.chunkSamples) void this.flushPending();
    };

    this.micSource.connect(this.mixBus);
    this.systemSource?.connect(this.mixBus);
    this.mixBus.connect(this.limiter);
    this.limiter.connect(this.taps, 0, 0);
    // Pre-mix taps. A missing system stream simply leaves input 2 silent, which the
    // engine reads as "mic-only session" without any special case.
    this.micSource.connect(this.taps, 0, 1);
    this.systemSource?.connect(this.taps, 0, 2);
    this.taps.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  // Fold this callback's raw mic/system samples into ENVELOPE_FRAME_SAMPLES-sized RMS
  // frames. The partial frame at the end of a callback carries over rather than being
  // rounded away, so the envelope stays aligned with the PCM even if the callback size
  // is not a whole number of frames.
  private measureSources(buffer: AudioBuffer): void {
    // Defensive: everything we build feeds three channels, but a graph that somehow
    // delivered fewer must degrade to "no envelope", not break the recording.
    if (buffer.numberOfChannels < 3) return;
    const mic = buffer.getChannelData(1);
    const system = buffer.getChannelData(2);

    for (let i = 0; i < mic.length; i++) {
      const systemSample = system[i] ?? 0;
      this.micSquares += mic[i] * mic[i];
      this.systemSquares += systemSample * systemSample;
      if (++this.frameFill < ENVELOPE_FRAME_SAMPLES) continue;
      this.pendingMic.push(Math.sqrt(this.micSquares / ENVELOPE_FRAME_SAMPLES));
      this.pendingSystem.push(Math.sqrt(this.systemSquares / ENVELOPE_FRAME_SAMPLES));
      this.frameFill = 0;
      this.micSquares = 0;
      this.systemSquares = 0;
    }
  }

  begin(): void {
    this.paused = false;
  }

  // Flush the pending sub-buffer through onChunk. Returns whatever onChunk returns so
  // the final Stop flush can be awaited. No-op when nothing is pending.
  private flushPending(): void | Promise<void> {
    if (this.pendingSamples === 0) return;
    const pcm = mergeChunks(this.pending);
    const envelope: SourceEnvelope = {
      mic: Float32Array.from(this.pendingMic),
      system: Float32Array.from(this.pendingSystem),
    };
    this.pending = [];
    this.pendingSamples = 0;
    this.pendingMic = [];
    this.pendingSystem = [];
    return this.onChunk?.(pcm, envelope);
  }

  // Flush before closing the gate so the engine receives the exact pause boundary.
  async pause(): Promise<void> {
    const flushed = this.flushPending();
    this.paused = true;
    await flushed;
  }

  resume(): void {
    this.paused = false;
  }

  // Release a prepared/acquired recorder without producing a WAV, used when any Start
  // step fails before capture becomes an active session.
  async dispose(): Promise<void> {
    await this.teardown();
    this.resetBuffers();
  }

  // Stop capture and return the authoritative mixed recording as a WAV. The pending
  // sub-buffer is awaited first so the live transcript includes the same trailing audio.
  async stop(): Promise<ArrayBuffer> {
    this.paused = true;
    await this.flushPending();

    const rate = this.ctx?.sampleRate ?? TARGET_RATE;
    const pcm = mergeChunks(this.chunks);

    await this.teardown();
    this.resetBuffers();

    return encodeWav(pcm, rate);
  }

  private watchTracks(stream: MediaStream, label: string): void {
    for (const track of stream.getAudioTracks()) {
      track.addEventListener(
        'ended',
        () => {
          if (!this.shuttingDown) {
            this.deps.logger.warn(`[recorder] ${label} track ended; continuing with remaining inputs.`);
          }
        },
        { once: true },
      );
    }
  }

  private async teardown(): Promise<void> {
    this.paused = true;
    this.shuttingDown = true;

    if (this.node) this.node.onaudioprocess = null;
    this.node?.disconnect();
    this.taps?.disconnect();
    this.limiter?.disconnect();
    this.mixBus?.disconnect();
    this.systemSource?.disconnect();
    this.micSource?.disconnect();
    stopStream(this.systemStream);
    stopStream(this.micStream);

    const ctx = this.ctx;
    this.ctx = null;
    this.node = null;
    this.taps = null;
    this.limiter = null;
    this.mixBus = null;
    this.systemSource = null;
    this.micSource = null;
    this.systemStream = null;
    this.micStream = null;

    await ctx?.close();
  }

  private clearPending(): void {
    this.pending = [];
    this.pendingSamples = 0;
    this.pendingMic = [];
    this.pendingSystem = [];
    this.frameFill = 0;
    this.micSquares = 0;
    this.systemSquares = 0;
  }

  private resetBuffers(): void {
    this.chunks = [];
    this.clearPending();
    this.chunkSamples = 0;
    this.onChunk = null;
  }
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Encode mono Float32 PCM as a 16-bit PCM WAV file.
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}
