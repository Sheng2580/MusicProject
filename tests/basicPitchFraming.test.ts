import * as tf from '@tensorflow/tfjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameBasicPitchAudio } from '../src/lib/melodyTranscription';

beforeAll(async () => {
  await tf.setBackend('cpu');
  await tf.ready();
});

afterAll(() => {
  tf.disposeVariables();
});

describe('Basic Pitch WASM-compatible framing', () => {
  it('pads a short signal into the original float32 model window', async () => {
    const tensorsBefore = tf.memory().numTensors;
    const framed = frameBasicPitchAudio(tf, Float32Array.of(.25, -.5, 1));

    expect(framed.dtype).toBe('float32');
    expect(framed.shape).toEqual([1, 43_844, 1]);
    expect(tf.memory().numTensors).toBe(tensorsBefore + 1);
    const values = await framed.data();
    expect(values[3_839]).toBe(0);
    expect(Array.from(values.slice(3_840, 3_843))).toEqual([.25, -.5, 1]);
    expect(values[3_843]).toBe(0);
    expect(values.at(-1)).toBe(0);

    framed.dispose();
    expect(tf.memory().numTensors).toBe(tensorsBefore);
  });

  it('uses the same overlapping frame starts as Basic Pitch 1.0.1', async () => {
    const samples = Float32Array.from({ length: 40_000 }, (_, index) => index / 40_000);
    const framed = frameBasicPitchAudio(tf, samples);

    expect(framed.shape).toEqual([2, 43_844, 1]);
    const values = await framed.data();
    const secondFrame = 43_844;
    expect(values[secondFrame]).toBeCloseTo(samples[32_324], 6);
    expect(values[secondFrame + 7_675]).toBeCloseTo(samples[39_999], 6);
    expect(values[secondFrame + 7_676]).toBe(0);

    framed.dispose();
  });
});
