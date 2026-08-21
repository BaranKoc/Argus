// Shared audio decoding.
//
// Decode a container to a mono Float32 PCM signal at 16 kHz. This lives here —
// not inside the transcriber — so a single decode can feed BOTH consumers of a
// request: Whisper (transcriber.ts) and the speaker diarizer (diarizer.ts).
// index.ts decodes once and passes the samples to each, avoiding a second full
// decode of the same file.
//
// Fast path: `audio-decode` (pure JS/WASM) handles mp3/wav/flac/ogg/opus/qoa.
// It has NO AAC/MP4 decoder, so m4a/webm/aac (all offered in the file dialog)
// throw "Missing decoder". For those we fall back to a bundled ffmpeg binary
// (ffmpeg-static) — no dependency on a system ffmpeg being on PATH. ffmpeg
// covers essentially every container, so the fallback also future-proofs odd
// inputs.

import decodeAudio from 'audio-decode';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
// Import from the transformers-free leaf (NOT models.ts) so the diarization
// worker can reuse loadAudio without pulling in @huggingface/transformers.
import { SAMPLE_RATE } from '../diarization-config.ts';

// Decode a file to a mono Float32 PCM signal at SAMPLE_RATE (16 kHz), which is
// what both Whisper's feature extractor and the diarization models expect.
export async function loadAudio(audioPath: string): Promise<Float32Array> {
  const fileBuffer = await fs.readFile(audioPath);

  let audioBuffer;
  try {
    audioBuffer = await decodeAudio(fileBuffer);
  } catch {
    // audio-decode can't handle this container (e.g. m4a/webm/aac) — let ffmpeg
    // do it. It emits mono @ SAMPLE_RATE directly, so no mixdown/resample after.
    return decodeViaFfmpeg(audioPath);
  }

  // Mixdown to mono by averaging channels.
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }

  if (audioBuffer.sampleRate === SAMPLE_RATE) return mono;
  return resample(mono, audioBuffer.sampleRate, SAMPLE_RATE);
}

// Fallback decoder: shell out to the bundled ffmpeg and read raw 32-bit-float
// mono PCM at SAMPLE_RATE from stdout. ffmpeg does the channel mixdown and
// resample itself, so the samples come back ready to use. spawn (not execFile)
// streams stdout with no maxBuffer cap, which matters for long meetings.
function decodeViaFfmpeg(audioPath: string): Promise<Float32Array> {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found');
  return new Promise((resolve, reject) => {
    const args = [
      '-nostdin',
      '-loglevel', 'error',
      '-i', audioPath,
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-',
    ];
    const ff = spawn(ffmpegPath, args);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr.on('data', (c: Buffer) => errChunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(errChunks).toString().trim();
        reject(new Error(`ffmpeg decode failed (exit ${code})${msg ? `: ${msg}` : ''}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      // Copy into a fresh Float32Array: the concatenated Buffer's backing
      // ArrayBuffer may be offset/oversized, and Whisper expects a plain view.
      const samples = new Float32Array(buf.length / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
      resolve(samples);
    });
  });
}

// Linear-interpolation resampler to the target rate.
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx];
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}
