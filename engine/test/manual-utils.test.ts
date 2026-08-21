import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { writeMonoPcm16Wav } from './manual-utils.ts';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('writeMonoPcm16Wav', () => {
  it('creates the 16-bit mono RIFF WAV contract used by the live recorder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-wav-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'recording.wav');
    writeMonoPcm16Wav(file, new Float32Array([-1, 0, 1]), 16000);
    const wav = fs.readFileSync(file);
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [-32768, 0, 32767]);
  });
});
