// Unit tests for parseDtype (npm test). Pure string logic — no model/audio.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDtype } from '../models.ts';

describe('parseDtype', () => {
  it('passes a scalar dtype through unchanged (backward compatible)', () => {
    assert.equal(parseDtype('q8'), 'q8');
    assert.equal(parseDtype('fp32'), 'fp32');
    assert.equal(parseDtype('fp16'), 'fp16');
    assert.equal(parseDtype('q4'), 'q4');
  });

  it('trims surrounding whitespace on a scalar', () => {
    assert.equal(parseDtype('  q8  '), 'q8');
  });

  it('parses split dtype into the Transformers.js sub-model keys', () => {
    assert.deepEqual(parseDtype('encoder=q8,decoder=fp32'), {
      encoder_model: 'q8',
      decoder_model_merged: 'fp32',
    });
  });

  it('tolerates spaces and either alias for the sub-model names', () => {
    assert.deepEqual(parseDtype(' encoder_model = q8 , decoder = fp16 '), {
      encoder_model: 'q8',
      decoder_model_merged: 'fp16',
    });
  });

  it('accepts a partial split (only one sub-model specified)', () => {
    assert.deepEqual(parseDtype('decoder=fp32'), { decoder_model_merged: 'fp32' });
  });

  it('throws on an invalid dtype token', () => {
    assert.throws(() => parseDtype('q3'), /Geçersiz dtype/);
    assert.throws(() => parseDtype('encoder=q8,decoder=bogus'), /Geçersiz dtype/);
  });

  it('throws on an unknown sub-model name', () => {
    assert.throws(() => parseDtype('foo=q8'), /Bilinmeyen alt-model/);
  });

  it('throws on empty input', () => {
    assert.throws(() => parseDtype('   '), /Boş dtype/);
  });
});
