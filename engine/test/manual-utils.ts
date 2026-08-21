// Shared helpers for the manual dev tool (manual-run.ts).
// These are NOT part of `npm test` — the runner glob is *.test.ts, this file is not.
//
// Paths live in bench/matrix.ts (the one place that computes them); this file used to
// derive its own ROOT in parallel, which is how the two halves drifted apart.

import fs from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';

// Prompting that works on BOTH a terminal and a pipe.
//
// WHY NOT readline/promises' question(): on a piped stdin
// (`printf 'S1-C.mp3\n1\n' | npm run test-run`, which is how automation drives this tool)
// the FIRST question drains the buffered input and the stream ends; the SECOND question's
// promise then never settles, the event loop empties, and the process exits 0 having done
// nothing at all — silently. Node flags it as "unsettled top-level await".
//
// So we consume 'line' events into a queue instead: piped lines are buffered as they
// arrive and handed out on demand, while a real TTY just waits for the next line.
let rl: Interface | null = null;
const answers: string[] = []; // lines that arrived before anyone asked
const waiting: ((v: string) => void)[] = []; // asks waiting for a line
let ended = false;

function ensureReader(): void {
  if (rl) return;
  rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line.trim());
    else answers.push(line.trim());
  });
  // EOF with someone still waiting: hand back '' so the caller's own default/validation
  // decides, rather than hanging forever.
  rl.on('close', () => {
    ended = true;
    while (waiting.length) waiting.shift()!('');
  });
}

export async function ask(question: string): Promise<string> {
  ensureReader();
  process.stdout.write(question);
  if (answers.length) {
    const answer = answers.shift()!;
    process.stdout.write(`${answer}\n`); // echo — piped input never appears on screen
    return answer;
  }
  if (ended) {
    process.stdout.write('\n');
    return '';
  }
  return new Promise((resolve) => waiting.push(resolve));
}

// Release stdin once prompting is done, so the process can exit when the work finishes.
export function closeAsk(): void {
  rl?.close();
  rl = null;
}

// Write data as pretty JSON, creating parent dirs. Runs live in their own timestamped
// directory, so names never collide and the old incremental _1/_2 probing is gone.
export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// The live manual runner starts with fixture formats such as MP3, while the real
// Electron recorder passes a 16-bit PCM WAV into finalize(). Create that exact seam
// so its Pyannote coverage matches the production call path.
export function writeMonoPcm16Wav(filePath: string, samples: Float32Array, sampleRate: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const dataBytes = samples.length * 2;
  const wav = Buffer.allocUnsafe(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    wav.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + index * 2);
  }
  fs.writeFileSync(filePath, wav);
}

// List the entries of a directory (empty array if it doesn't exist) — used to
// show the developer what's available when they mistype a filename.
export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
