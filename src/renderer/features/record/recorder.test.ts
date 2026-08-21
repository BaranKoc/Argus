import assert from 'node:assert/strict';
import test from 'node:test';
import { Recorder, type RecorderDependencies } from './recorder.ts';
import { ENVELOPE_FRAME_SAMPLES } from '../../../../engine/live/source-envelope.ts';

class FakeTrack {
  stopped = false;
  private ended: (() => void) | null = null;

  stop(): void {
    this.stopped = true;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== 'ended') return;
    this.ended =
      typeof listener === 'function' ? () => listener(new Event('ended')) : () => listener.handleEvent(new Event('ended'));
  }

  end(): void {
    this.ended?.();
  }
}

class FakeStream {
  readonly audio: FakeTrack[];
  readonly video: FakeTrack[];

  constructor(audio: FakeTrack[], video: FakeTrack[] = []) {
    this.audio = audio;
    this.video = video;
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.audio as unknown as MediaStreamTrack[];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.video as unknown as MediaStreamTrack[];
  }

  getTracks(): MediaStreamTrack[] {
    return [...this.audio, ...this.video] as unknown as MediaStreamTrack[];
  }
}

class FakeNode {
  connections: Array<{ to: FakeNode; input: number }> = [];
  disconnected = false;

  connect(destination: FakeNode, _output = 0, input = 0): FakeNode {
    this.connections.push({ to: destination, input });
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  // Which merger input this node feeds, or -1 when it does not reach it at all — the
  // readable form of "the mic tap is on channel 1".
  inputInto(destination: FakeNode): number {
    return this.connections.find((c) => c.to === destination)?.input ?? -1;
  }
}

class FakeMerger extends FakeNode {}

class FakeGain extends FakeNode {
  channelCount = 2;
  channelCountMode: ChannelCountMode = 'max';
  channelInterpretation: ChannelInterpretation = 'speakers';
}

class FakeCompressor extends FakeNode {
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
}

class FakeProcessor extends FakeNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;

  // The real graph hands the processor three channels at once: the finished mix, then
  // the raw mic and system taps. Tests that only care about the mix pass one array.
  emit(mix: number[], mic: number[] = [], system: number[] = []): void {
    const channels = [mix, mic, system].map((samples) => Float32Array.from(samples));
    this.onaudioprocess?.({
      inputBuffer: {
        numberOfChannels: channels.length,
        getChannelData: (channel: number) => channels[channel],
      },
    } as unknown as AudioProcessingEvent);
  }
}

class FakeAudioContext {
  readonly sampleRate = 16000;
  readonly destination = new FakeNode();
  readonly sources: FakeNode[] = [];
  readonly gain = new FakeGain();
  readonly compressor = new FakeCompressor();
  readonly merger = new FakeMerger();
  readonly processor = new FakeProcessor();
  mergerInputs = 0;
  processorChannels = 0;
  closed = false;

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    const source = new FakeNode();
    this.sources.push(source);
    return source as unknown as MediaStreamAudioSourceNode;
  }

  createGain(): GainNode {
    return this.gain as unknown as GainNode;
  }

  createDynamicsCompressor(): DynamicsCompressorNode {
    return this.compressor as unknown as DynamicsCompressorNode;
  }

  createChannelMerger(inputs: number): ChannelMergerNode {
    this.mergerInputs = inputs;
    return this.merger as unknown as ChannelMergerNode;
  }

  createScriptProcessor(_bufferSize: number, inputChannels: number): ScriptProcessorNode {
    this.processorChannels = inputChannels;
    return this.processor as unknown as ScriptProcessorNode;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function stream(audio: FakeTrack[], video: FakeTrack[] = []): MediaStream {
  return new FakeStream(audio, video) as unknown as MediaStream;
}

function dependencies(
  mediaDevices: Pick<MediaDevices, 'getUserMedia' | 'getDisplayMedia'>,
  context: FakeAudioContext,
): { deps: RecorderDependencies; info: string[]; warnings: string[] } {
  const info: string[] = [];
  const warnings: string[] = [];
  return {
    deps: {
      mediaDevices,
      createAudioContext: () => context as unknown as AudioContext,
      logger: {
        info: (message?: unknown) => info.push(String(message)),
        warn: (message?: unknown) => warnings.push(String(message)),
      },
    },
    info,
    warnings,
  };
}

test('captures mic and system audio, gates PCM, clamps peaks, and cleans every resource', async () => {
  const mic = new FakeTrack();
  const systemAudio = new FakeTrack();
  const displayVideo = new FakeTrack();
  const calls: string[] = [];
  const context = new FakeAudioContext();
  const setup = dependencies(
    {
      getDisplayMedia: async (constraints) => {
        calls.push('system');
        assert.deepEqual(constraints, { audio: true, video: true });
        return stream([systemAudio], [displayVideo]);
      },
      getUserMedia: async (constraints) => {
        calls.push('mic');
        assert.deepEqual(constraints, {
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        return stream([mic]);
      },
    },
    context,
  );
  const recorder = new Recorder(setup.deps);

  await recorder.acquire();
  assert.deepEqual(calls, ['system', 'mic']);
  assert.equal(displayVideo.stopped, true);
  assert.equal(systemAudio.stopped, false);
  assert.match(setup.info[0], /mic\+system/);

  const chunks: number[][] = [];
  recorder.prepare((pcm) => {
    chunks.push(Array.from(pcm));
  }, 10);
  assert.equal(context.sources.length, 2);
  assert.equal(context.gain.channelCount, 1);
  assert.equal(context.gain.channelCountMode, 'explicit');
  assert.equal(context.compressor.threshold.value, -3);
  assert.equal(context.compressor.ratio.value, 20);

  context.processor.emit([0.9]);
  recorder.begin();
  context.processor.emit([0.25, 2, -2]);
  await recorder.pause();
  assert.deepEqual(chunks, [[0.25, 1, -1]]);

  context.processor.emit([0.75]);
  recorder.resume();
  context.processor.emit([0.5]);
  const wav = await recorder.stop();

  assert.deepEqual(chunks, [[0.25, 1, -1], [0.5]]);
  assert.equal(new DataView(wav).getUint32(40, true), 8);
  assert.equal(mic.stopped, true);
  assert.equal(systemAudio.stopped, true);
  assert.equal(context.closed, true);
  assert.equal(context.processor.disconnected, true);
});

test('measures a per-source RMS envelope alongside the mix', async () => {
  const context = new FakeAudioContext();
  const setup = dependencies(
    {
      getDisplayMedia: async () => stream([new FakeTrack()], [new FakeTrack()]),
      getUserMedia: async () => stream([new FakeTrack()]),
    },
    context,
  );
  const recorder = new Recorder(setup.deps);
  await recorder.acquire();

  const captured: Array<{ samples: number; mic: number[]; system: number[] }> = [];
  const frame = 1 / 16000;
  recorder.prepare(
    (pcm, envelope) => {
      captured.push({
        samples: pcm.length,
        mic: Array.from(envelope.mic),
        system: Array.from(envelope.system),
      });
    },
    ENVELOPE_FRAME_SAMPLES * 2 * frame,
  );

  // The mix keeps channel 0 so nothing about the recorded audio changes; the raw taps
  // ride along on 1 and 2.
  assert.equal(context.mergerInputs, 3);
  assert.equal(context.processorChannels, 3);
  assert.equal(context.compressor.inputInto(context.merger), 0);
  assert.equal(context.sources[0].inputInto(context.merger), 1);
  assert.equal(context.sources[1].inputInto(context.merger), 2);

  recorder.begin();
  const loud = new Array(ENVELOPE_FRAME_SAMPLES).fill(0.5);
  const quiet = new Array(ENVELOPE_FRAME_SAMPLES).fill(0);
  context.processor.emit(new Array(ENVELOPE_FRAME_SAMPLES * 2).fill(0.1), [...loud, ...quiet], [...quiet, ...loud]);
  await recorder.pause();

  assert.equal(captured.length, 1);
  assert.equal(captured[0].samples, ENVELOPE_FRAME_SAMPLES * 2);
  assert.deepEqual(captured[0].mic, [0.5, 0]);
  assert.deepEqual(captured[0].system, [0, 0.5]);

  await recorder.dispose();
});

test('carries a partial envelope frame across callbacks instead of rounding it away', async () => {
  const context = new FakeAudioContext();
  const setup = dependencies(
    {
      getDisplayMedia: async () => stream([new FakeTrack()]),
      getUserMedia: async () => stream([new FakeTrack()]),
    },
    context,
  );
  const recorder = new Recorder(setup.deps);
  await recorder.acquire();

  const captured: number[][] = [];
  recorder.prepare((_pcm, envelope) => {
    captured.push(Array.from(envelope.mic));
  }, 1 / 16000);
  recorder.begin();

  // One and a half frames, then the other half: the second frame must be built from
  // both callbacks rather than each callback rounding down to whole frames.
  const half = ENVELOPE_FRAME_SAMPLES / 2;
  context.processor.emit(
    new Array(ENVELOPE_FRAME_SAMPLES + half).fill(0),
    [...new Array(ENVELOPE_FRAME_SAMPLES).fill(0), ...new Array(half).fill(1)],
    [],
  );
  context.processor.emit(new Array(half).fill(0), new Array(half).fill(1), []);
  await recorder.pause();

  assert.deepEqual(captured, [[0], [1]]);
  await recorder.dispose();
});

test('continues mic-only when loopback capture is rejected', async () => {
  const mic = new FakeTrack();
  const context = new FakeAudioContext();
  const setup = dependencies(
    {
      getDisplayMedia: async () => {
        throw new Error('loopback unavailable');
      },
      getUserMedia: async () => stream([mic]),
    },
    context,
  );
  const recorder = new Recorder(setup.deps);

  await recorder.acquire();
  recorder.prepare(() => undefined, 10);
  assert.equal(context.sources.length, 1);
  assert.match(setup.info[0], /mic-only/);
  assert.match(setup.warnings[0], /System audio unavailable/);

  await recorder.dispose();
  assert.equal(mic.stopped, true);
  assert.equal(context.closed, true);
});

test('treats a display stream without an audio track as mic-only', async () => {
  const mic = new FakeTrack();
  const displayVideo = new FakeTrack();
  const context = new FakeAudioContext();
  const setup = dependencies(
    {
      getDisplayMedia: async () => stream([], [displayVideo]),
      getUserMedia: async () => stream([mic]),
    },
    context,
  );
  const recorder = new Recorder(setup.deps);

  await recorder.acquire();
  recorder.prepare(() => undefined, 10);
  assert.equal(context.sources.length, 1);
  assert.equal(displayVideo.stopped, true);
  assert.match(setup.warnings[0], /System audio unavailable/);
  await recorder.dispose();
});

test('microphone failure rejects capture and stops an acquired display stream', async () => {
  const systemAudio = new FakeTrack();
  const displayVideo = new FakeTrack();
  const context = new FakeAudioContext();
  const setup = dependencies(
    {
      getDisplayMedia: async () => stream([systemAudio], [displayVideo]),
      getUserMedia: async () => {
        throw new Error('microphone denied');
      },
    },
    context,
  );
  const recorder = new Recorder(setup.deps);

  await assert.rejects(() => recorder.acquire(), /microphone denied/);
  assert.equal(systemAudio.stopped, true);
  assert.equal(displayVideo.stopped, true);
  assert.equal(setup.info.length, 0);
});

test('logs an unexpected input-track end without aborting the recorder', async () => {
  const mic = new FakeTrack();
  const systemAudio = new FakeTrack();
  const context = new FakeAudioContext();
  const setup = dependencies(
    {
      getDisplayMedia: async () => stream([systemAudio]),
      getUserMedia: async () => stream([mic]),
    },
    context,
  );
  const recorder = new Recorder(setup.deps);

  await recorder.acquire();
  systemAudio.end();
  assert.match(setup.warnings[0], /system audio track ended/);
  await recorder.dispose();
});
