import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAccompaniment } from '../src/lib/accompaniment';
import type { ChordSegment, SongAnalysis } from '../src/types';

const sampleRate = 22050;

function segment(chord = 'C', start = 0, end = 2): ChordSegment {
  return { id: `${chord}-${start}`, chord, start, end, confidence: 0.9 };
}

function analysis(overrides: Partial<SongAnalysis> = {}): SongAnalysis {
  return {
    duration: 2,
    bpm: 120,
    beats: [0, 0.5, 1, 1.5],
    chords: [segment()],
    waveform: [],
    key: 'C',
    confidence: 0.9,
    algorithm: 'test',
    ...overrides,
  };
}

interface TestMelodyNote {
  start: number;
  duration: number;
  midi: number;
  confidence: number;
  strength: number;
}

function withMelody(melody: TestMelodyNote[], overrides: Partial<SongAnalysis> = {}): SongAnalysis {
  return { ...analysis(overrides), melody } as SongAnalysis;
}

async function readWave(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const text = (start: number, length: number) => new TextDecoder().decode(new Uint8Array(buffer, start, length));
  return { buffer, view, text };
}

async function samplesFor(input: SongAnalysis, practiceRate = 1): Promise<Int16Array> {
  const { buffer, view } = await readWave(renderAccompaniment(input, practiceRate));
  const samples = new Int16Array((buffer.byteLength - 44) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true);
  return samples;
}

function window(samples: Int16Array, start: number, end: number) {
  return samples.subarray(Math.ceil(start * sampleRate), Math.ceil(end * sampleRate));
}

function peak(samples: Int16Array): number {
  return samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
}

function magnitudeBetween(samples: Int16Array, start: number, end: number, frequency: number): number {
  const excerpt = window(samples, start, end);
  let real = 0;
  let imaginary = 0;
  let weightSum = 0;
  for (let i = 0; i < excerpt.length; i++) {
    const weight = 0.5 * (1 - Math.cos(2 * Math.PI * i / (excerpt.length - 1)));
    const phase = 2 * Math.PI * frequency * i / sampleRate;
    const value = excerpt[i] / 32768 * weight;
    real += value * Math.cos(phase);
    imaginary += value * Math.sin(phase);
    weightSum += weight;
  }
  return Math.hypot(real, imaginary) / weightSum;
}

function magnitude(samples: Int16Array, frequency: number): number {
  return magnitudeBetween(samples, 0.03, 0.4, frequency);
}

describe('locally rendered accompaniment', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('synchronously returns a complete mono PCM16 WAV at 22050 Hz', async () => {
    const blob = renderAccompaniment(analysis({ duration: 1.2 }));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/wav');
    const { buffer, view, text } = await readWave(blob);
    const dataBytes = 1.2 * sampleRate * 2;
    expect(buffer.byteLength).toBe(44 + dataBytes);
    expect(text(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(dataBytes);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('makes a valid empty WAV for unusable duration %s', async duration => {
    const blob = renderAccompaniment(analysis({ duration }));
    const { view, text } = await readWave(blob);
    expect(blob.size).toBe(44);
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(36);
    expect(view.getUint32(40, true)).toBe(0);
  });

  it('caps oversized durations at ten minutes', async () => {
    const blob = renderAccompaniment(analysis({ duration: 1000000, beats: [], chords: [] }));
    expect(blob.size).toBe(44 + 600 * sampleRate * 2);
    const { view } = await readWave(blob);
    expect(view.getUint32(40, true)).toBe(600 * sampleRate * 2);
  });

  it.each([0.5, 0.75])('renders physical duration at practice rate %s', async rate => {
    const input = analysis({ duration: 3 });
    const blob = renderAccompaniment(input, rate);
    const { view } = await readWave(blob);
    const dataBytes = Math.round(3 / rate * sampleRate) * 2;
    expect(blob.size).toBe(44 + dataBytes);
    expect(view.getUint32(40, true)).toBe(dataBytes);
    expect(view.getUint32(24, true)).toBe(sampleRate);
  });

  it('caps source duration before slowing, allowing at most twenty physical minutes', () => {
    const blob = renderAccompaniment(analysis({ duration: 1000000, beats: [], chords: [] }), 0.5);
    expect(blob.size).toBe(44 + 1200 * sampleRate * 2);
  });

  it('keeps omitted rate identical to explicit normal speed', async () => {
    const input = analysis();
    expect(new Uint8Array(await renderAccompaniment(input).arrayBuffer()))
      .toEqual(new Uint8Array(await renderAccompaniment(input, 1).arrayBuffer()));
  });

  it('keeps an explicitly empty melody backward-compatible with chord-only rendering', async () => {
    const input = analysis();
    const emptyMelody = { ...input, melody: [] } as SongAnalysis;
    expect(await samplesFor(emptyMelody)).toEqual(await samplesFor(input));
  });

  it.each([NaN, Infinity, -Infinity, 2])('uses normal speed for rate %s', async rate => {
    const input = analysis({ duration: 0.5, beats: [0] });
    expect(await samplesFor(input, rate)).toEqual(await samplesFor(input, 1));
  });

  it.each([0, -1, 0.1])('clamps rate %s to half speed', async rate => {
    const input = analysis({ duration: 0.5, beats: [0] });
    expect(await samplesFor(input, rate)).toEqual(await samplesFor(input, 0.5));
  });

  it.each([0.5, 0.75])('slows detected beat positions and chord boundaries together at rate %s', async rate => {
    const samples = await samplesFor(analysis({
      beats: [0.5, 1, 1.5],
      chords: [segment('C', 0.5, 0.9), segment('N', 0.9, 1.5), segment('G', 1.5, 1.9)],
    }), rate);
    expect(peak(window(samples, 0, 0.5 / rate))).toBe(0);
    expect(peak(window(samples, 0.51 / rate, 0.8 / rate))).toBeGreaterThan(100);
    expect(peak(window(samples, 0.9 / rate, 1.5 / rate))).toBe(0);
    expect(peak(window(samples, 1.51 / rate, 1.8 / rate))).toBeGreaterThan(100);
    expect(peak(window(samples, 1.9 / rate, 2 / rate))).toBe(0);
  });

  it.each([0.5, 0.75])('slows pulse spacing without lowering note pitches at rate %s', async rate => {
    const samples = await samplesFor(analysis({ duration: 1, beats: [0, 0.5], chords: [segment('C', 0, 1)] }), rate);
    const c2 = 65.406;
    const e4 = 329.628;
    expect(magnitude(samples, c2)).toBeGreaterThan(0.01);
    expect(magnitude(samples, e4)).toBeGreaterThan(0.002);
    expect(magnitude(samples, e4)).toBeGreaterThan(2 * magnitude(samples, e4 * rate));
    // The next pulse begins at its slowed position, with the same pitch.
    expect(peak(window(samples, 0.5 / rate, 0.5 / rate + 0.05))).toBeGreaterThan(100);
  });

  it.each([0.5, 0.75])('uses the reduced BPM for the pulse duration at rate %s', async rate => {
    const input = analysis({ duration: 1.5, beats: [0], chords: [segment('C', 0, 1.5)] });
    expect(peak(window(await samplesFor(input), 0.51, 0.6))).toBe(0);
    const slowed = await samplesFor(input, rate);
    expect(peak(window(slowed, 0.51, 0.6))).toBeGreaterThan(100);
    expect(peak(window(slowed, 0.5 / rate, 1.5 / rate))).toBe(0);
  });

  it.each([0, -120, NaN, Infinity, -Infinity])('leaves accompaniment silent when BPM is %s', async bpm => {
    expect(peak(await samplesFor(analysis({ bpm })))).toBe(0);
  });

  it.each(['N', 'unknown', 'H', 'toString', 'C7'])('does not invent notes for unsupported chord %s', async chord => {
    expect(peak(await samplesFor(analysis({ chords: [segment(chord)] })))).toBe(0);
  });

  it('leaves missing beats or missing harmony silent', async () => {
    expect(peak(await samplesFor(analysis({ beats: [] })))).toBe(0);
    expect(peak(await samplesFor(analysis({ chords: [] })))).toBe(0);
  });

  it('renders a clear melody even without tempo, beats, or harmony', async () => {
    const samples = await samplesFor(withMelody([
      { start: 0.2, duration: 0.55, midi: 69, confidence: 0.9, strength: 0.85 },
    ], { duration: 1, bpm: 0, beats: [], chords: [] }));
    expect(peak(window(samples, 0, 0.2))).toBe(0);
    expect(peak(window(samples, 0.21, 0.7))).toBeGreaterThan(1000);
    expect(magnitudeBetween(samples, 0.21, 0.6, 440)).toBeGreaterThan(0.04);
  });

  it('suppresses the unreliable detected chord bed when a melody is available', async () => {
    const chordOnly = await samplesFor(analysis({ duration: 0.8, beats: [0], chords: [segment('C', 0, 0.8)] }));
    const melodic = await samplesFor(withMelody([
      { start: 0, duration: 0.7, midi: 69, confidence: 1, strength: 1 },
    ], { duration: 0.8, beats: [0], chords: [segment('C', 0, 0.8)] }));
    expect(magnitude(melodic, 440)).toBeGreaterThan(0.04);
    expect(magnitude(melodic, 65.406)).toBeLessThan(0.0005);
    expect(magnitude(chordOnly, 65.406)).toBeGreaterThan(0.01);
  });

  it('stretches melody timing at practice speed without lowering its pitch', async () => {
    const input = withMelody([
      { start: 0.25, duration: 0.3, midi: 69, confidence: 0.8, strength: 0.7 },
    ], { duration: 1, bpm: 0, beats: [], chords: [] });
    const slowed = await samplesFor(input, 0.5);
    expect(peak(window(slowed, 0, 0.5))).toBe(0);
    expect(peak(window(slowed, 0.51, 1.05))).toBeGreaterThan(1000);
    expect(magnitudeBetween(slowed, 0.51, 0.95, 440)).toBeGreaterThan(4 * magnitudeBetween(slowed, 0.51, 0.95, 220));
  });

  it('ignores malformed and out-of-range melody events', async () => {
    const valid = { start: 0.1, duration: 0.4, midi: 69, confidence: 0.8, strength: 0.7 };
    const invalid = [
      { ...valid, start: NaN }, { ...valid, start: -0.1 }, { ...valid, start: 2 },
      { ...valid, duration: 0 }, { ...valid, duration: Infinity },
      { ...valid, midi: 23 }, { ...valid, midi: 109 }, { ...valid, midi: NaN },
      { ...valid, confidence: -0.1 }, { ...valid, confidence: 1.1 }, { ...valid, confidence: NaN },
      { ...valid, strength: -0.1 }, { ...valid, strength: 1.1 }, { ...valid, strength: Infinity },
    ];
    const clean = await samplesFor(withMelody([valid], { duration: 1, bpm: 0, beats: [], chords: [] }));
    const dirty = await samplesFor(withMelody([...invalid, valid], { duration: 1, bpm: 0, beats: [], chords: [] }));
    expect(dirty).toEqual(clean);
  });

  it('starts on detected beats and cuts every voice off at the chord boundary', async () => {
    const samples = await samplesFor(analysis({
      beats: [0.5, 1, 1.5],
      chords: [segment('C', 0.5, 1)],
    }));
    expect(peak(window(samples, 0, 0.5))).toBe(0);
    expect(peak(window(samples, 0.51, 0.95))).toBeGreaterThan(100);
    expect(peak(window(samples, 1, 2))).toBe(0);
  });

  it('waits for a detected beat inside a chord instead of triggering at its start', async () => {
    const samples = await samplesFor(analysis({
      beats: [0.25, 0.75, 1.75],
      chords: [segment('Am', 0.5, 1.25)],
    }));
    expect(peak(window(samples, 0, 0.75))).toBe(0);
    expect(peak(window(samples, 0.76, 1.2))).toBeGreaterThan(100);
    expect(peak(window(samples, 1.25, 2))).toBe(0);
  });

  it('preserves silence through unknown segments and gaps', async () => {
    const samples = await samplesFor(analysis({
      chords: [segment('C', 0, 0.4), segment('N', 0.5, 1), segment('G', 1, 1.4)],
    }));
    expect(peak(window(samples, 0.01, 0.35))).toBeGreaterThan(100);
    expect(peak(window(samples, 0.4, 1))).toBe(0);
    expect(peak(window(samples, 1.01, 1.35))).toBeGreaterThan(100);
    expect(peak(window(samples, 1.4, 2))).toBe(0);
  });

  it('ignores duplicate, nonfinite, and out-of-range beat positions', async () => {
    const clean = await samplesFor(analysis({ beats: [0.5, 1] }));
    const dirty = await samplesFor(analysis({ beats: [NaN, 1, -1, 0.5, Infinity, 1, 2, -Infinity, 20, 0.5] }));
    expect(dirty).toEqual(clean);
    expect(peak(dirty)).toBeGreaterThan(100);
    expect(dirty.every(sample => Number.isFinite(sample) && Math.abs(sample) <= Math.ceil(0.82 * 32768))).toBe(true);
  });

  it('skips chord segments with unusable timing', async () => {
    const samples = await samplesFor(analysis({
      chords: [
        segment('C', NaN, 1),
        segment('C', 0, NaN),
        segment('C', Infinity, 2),
        segment('C', 0, Infinity),
        segment('C', 1, 0.5),
        segment('C', 0.5, 0.5),
        segment('C', 3, 4),
      ],
    }));
    expect(peak(samples)).toBe(0);
  });

  it.each(['C', 'D', 'E', 'F', 'G', 'A', 'B', 'Cm', 'Cmin', 'F#m', 'Db', 'Bbmin'])('renders audible, bounded harmony for %s', async chord => {
    const samples = await samplesFor(analysis({ duration: 0.5, beats: [0], chords: [segment(chord, 0, 0.5)] }));
    expect(peak(samples)).toBeGreaterThan(100);
    expect(peak(samples)).toBeLessThanOrEqual(Math.ceil(0.82 * 32768));
  });

  it('distinguishes major and minor thirds in the rendered pitches', async () => {
    const major = await samplesFor(analysis({ duration: 0.5, beats: [0], chords: [segment('C', 0, 0.5)] }));
    const minor = await samplesFor(analysis({ duration: 0.5, beats: [0], chords: [segment('Cm', 0, 0.5)] }));
    const e4 = 329.628;
    const eFlat4 = 311.127;
    // The third changes while the shared root and fifth remain unchanged.
    expect(magnitude(major, e4)).toBeGreaterThan(0.002);
    expect(magnitude(minor, eFlat4)).toBeGreaterThan(0.002);
    expect(magnitude(major, e4)).toBeGreaterThan(1.5 * magnitude(major, eFlat4));
    expect(magnitude(minor, eFlat4)).toBeGreaterThan(1.5 * magnitude(minor, e4));
  });

  it('keeps dense overlapping pulses within the output amplitude limit', async () => {
    const samples = await samplesFor(analysis({ beats: Array.from({ length: 200 }, (_, index) => index / 100) }));
    expect(peak(samples)).toBeGreaterThan(100);
    expect(peak(samples)).toBeLessThanOrEqual(Math.ceil(0.82 * 32768));
  });

  it('needs no browser audio context and does not mutate the supplied analysis', async () => {
    const context = vi.fn(() => { throw new Error('An audio device must not be opened to render accompaniment'); });
    vi.stubGlobal('AudioContext', context);
    vi.stubGlobal('OfflineAudioContext', context);
    const input = analysis({ beats: [1, 0, 0.5] });
    Object.freeze(input.beats);
    input.chords.forEach(Object.freeze);
    Object.freeze(input.chords);
    Object.freeze(input);
    expect(peak(await samplesFor(input))).toBeGreaterThan(100);
    expect(peak(await samplesFor(input, 0.5))).toBeGreaterThan(100);
    expect(context).not.toHaveBeenCalled();
    expect(input.beats).toEqual([1, 0, 0.5]);
  });
});
