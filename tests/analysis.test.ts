import { describe, expect, it } from 'vitest';
import { ANALYSIS_SAMPLE_RATE, analyzeSamples } from '../src/lib/musicAnalysis';

const sampleRate = ANALYSIS_SAMPLE_RATE;
const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function chordSequence(sequence: { notes: number[]; duration: number }[]) {
  const samples = new Float32Array(Math.round(sequence.reduce((sum, chord) => sum + chord.duration, 0) * sampleRate));
  let offset = 0;
  for (const chord of sequence) {
    const length = Math.round(chord.duration * sampleRate);
    for (let i = 0; i < length && offset + i < samples.length; i++) {
      const envelope = Math.min(1, i / (sampleRate * 0.025), (length - i) / (sampleRate * 0.025));
      for (const midi of chord.notes) samples[offset + i] += 0.2 * envelope * Math.sin(2 * Math.PI * frequency(midi) * i / sampleRate);
    }
    offset += length;
  }
  return samples;
}

function clickTrack(bpm: number, duration = 16) {
  const samples = new Float32Array(Math.round(duration * sampleRate));
  for (let time = 0.25; time < duration; time += 60 / bpm) {
    const start = Math.round(time * sampleRate);
    for (let i = 0; i < 0.025 * sampleRate && start + i < samples.length; i++) {
      samples[start + i] += 0.8 * Math.exp(-i / (sampleRate * 0.005)) * Math.cos(2 * Math.PI * 1200 * i / sampleRate);
    }
  }
  return samples;
}

interface RhythmHit { amplitude: number; offset?: number }

function patternedClickTrack(bpm: number, duration: number, event: (beat: number) => RhythmHit[], rate = sampleRate) {
  const samples = new Float32Array(Math.round(duration * rate));
  const period = 60 / bpm;
  for (let beat = 0, time = 0.25; time < duration; beat++, time += period) {
    for (const hit of event(beat)) {
      const start = Math.round((time + (hit.offset ?? 0) * period) * rate);
      for (let i = 0; i < 0.035 * rate && start + i < samples.length; i++) {
        const frequency = beat % 4 === 0 ? 760 : 1180;
        samples[start + i] += hit.amplitude * Math.exp(-i / (rate * 0.007)) * Math.cos(2 * Math.PI * frequency * i / rate);
      }
    }
  }
  return samples;
}

describe('browser-local signal analysis', () => {
  it('leaves silence unknown instead of manufacturing chords or tempo', () => {
    const result = analyzeSamples(new Float32Array(sampleRate * 4), sampleRate);
    expect(result.bpm).toBe(0);
    expect(result.beats).toEqual([]);
    expect(result.chords).toEqual([{ id: 'chord-0', start: 0, end: 4, chord: 'N', confidence: 0 }]);
    expect(result.key).toBe('未知');
    expect(result.waveform.every(value => value === 0)).toBe(true);
  });

  it.each([60, 90, 120, 150, 180])('recovers a %i BPM click train and actual pulse positions', bpm => {
    const result = analyzeSamples(clickTrack(bpm), sampleRate);
    expect(Math.abs(result.bpm - bpm)).toBeLessThanOrEqual(2);
    expect(result.beats.length).toBeGreaterThan(8);
    const errors = result.beats.filter(time => time > 0.3 && time < 15.5).map(time => {
      const cycles = (time - 0.25) / (60 / bpm);
      return Math.abs(cycles - Math.round(cycles)) * (60 / bpm);
    });
    expect(Math.max(...errors)).toBeLessThan(0.055);
  });

  it.each([sampleRate, 22_050])('keeps accented eighth-note subdivisions under an 80 BPM beat at %i Hz', rate => {
    const samples = patternedClickTrack(80, 24, beat => [
      { amplitude: [0.9, 0.62, 0.76, 0.55][beat % 4] },
      { amplitude: 0.3, offset: 0.5 },
    ], rate);
    const result = analyzeSamples(samples, rate);
    expect(result.bpm).toBeGreaterThanOrEqual(79);
    expect(result.bpm).toBeLessThanOrEqual(81);
    expect(result.beats.length).toBeGreaterThanOrEqual(31);
    expect(result.beats.length).toBeLessThanOrEqual(33);
  });

  it.each([sampleRate, 22_050])('retains a syncopated irregular 170 BPM pulse and fills its missing beats at %i Hz', rate => {
    const samples = patternedClickTrack(170, 24, beat => [
      ...(beat % 5 === 3 ? [] : [{ amplitude: [0.9, 0.68, 0.78, 0.6][beat % 4] }]),
      ...(beat % 6 === 2 ? [{ amplitude: 0.27, offset: 0.55 }] : []),
    ], rate);
    const result = analyzeSamples(samples, rate);
    expect(result.bpm).toBeGreaterThanOrEqual(168);
    expect(result.bpm).toBeLessThanOrEqual(172);
    expect(result.beats.length).toBeGreaterThanOrEqual(67);
    expect(result.beats.length).toBeLessThanOrEqual(69);
  });

  it('detects different major and minor chords from pitches', () => {
    const sequence = [
      { notes: [48, 52, 55], duration: 3 },
      { notes: [45, 48, 52], duration: 3 },
      { notes: [53, 57, 60], duration: 3 },
      { notes: [43, 47, 50], duration: 3 },
    ];
    const result = analyzeSamples(chordSequence(sequence), sampleRate);
    for (const [time, expected] of [[1.5, 'C'], [4.5, 'Am'], [7.5, 'F'], [10.5, 'G']] as const) {
      expect(result.chords.find(segment => segment.start <= time && segment.end > time)?.chord).toBe(expected);
    }
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThanOrEqual(0.9);
    expect(result.chords[0].start).toBe(0);
    expect(result.chords.at(-1)?.end).toBe(12);
    result.chords.slice(1).forEach((segment, index) => expect(segment.start).toBe(result.chords[index].end));
  });

  it('changes the estimate when actual pitches are transposed', () => {
    const result = analyzeSamples(chordSequence([{ notes: [50, 54, 57], duration: 4 }]), sampleRate);
    expect(result.chords.find(segment => segment.start <= 2 && segment.end > 2)?.chord).toBe('D');
  });

  it('does not give broadband noise confident harmony', () => {
    let seed = 12345;
    const samples = Float32Array.from({ length: sampleRate * 4 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return seed / 2147483648 * 0.15;
    });
    const result = analyzeSamples(samples, sampleRate);
    const unknownDuration = result.chords.filter(segment => segment.chord === 'N').reduce((sum, segment) => sum + segment.end - segment.start, 0);
    expect(unknownDuration).toBeGreaterThan(3.5);
    expect(result.confidence).toBeLessThan(0.15);
  });

  it('bounds inputs and rejects corrupt samples', () => {
    expect(() => analyzeSamples(new Float32Array(0), sampleRate)).toThrow('太短');
    expect(() => analyzeSamples(new Float32Array(10), 0)).toThrow('采样率');
    expect(() => analyzeSamples(new Float32Array(sampleRate * 601), sampleRate)).toThrow('10 分钟');
    const samples = new Float32Array(sampleRate);
    samples[100] = NaN;
    expect(() => analyzeSamples(samples, sampleRate)).toThrow('无效');
  });

  it('reports monotonic progress and produces bounded waveform data', () => {
    const progress: number[] = [];
    const result = analyzeSamples(chordSequence([{ notes: [48, 51, 55], duration: 3 }]), sampleRate, update => progress.push(update.progress));
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(result.waveform.length).toBe(640);
    expect(result.waveform.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    expect(result.chords.find(segment => segment.start <= 1.5 && segment.end > 1.5)?.chord).toBe('Cm');
  });
});
