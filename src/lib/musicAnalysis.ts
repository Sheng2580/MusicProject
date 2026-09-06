import type { AnalysisProgress, ChordSegment, SongAnalysis } from '../types';

export const MAX_AUDIO_DURATION = 600;
export const ANALYSIS_SAMPLE_RATE = 11025;

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[middle] + sorted[Math.max(0, middle - (sorted.length % 2 === 0 ? 1 : 0))]) / 2 : 0;
};

interface SpectrumFrame {
  time: number;
  rms: number;
  flatness: number;
  chroma: Float64Array;
}

/** Iterative, in-place radix-2 FFT. The window and twiddle factors are reused. */
class Spectrum {
  readonly size: number;
  private real: Float64Array;
  private imaginary: Float64Array;
  private window: Float64Array;
  private reverse: Uint32Array;
  private cosine: Float64Array;
  private sine: Float64Array;
  readonly magnitude: Float64Array;

  constructor(sampleRate: number) {
    this.size = 2 ** Math.round(Math.log2(sampleRate * 0.37));
    const size = this.size;
    this.real = new Float64Array(size);
    this.imaginary = new Float64Array(size);
    this.window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
    this.reverse = new Uint32Array(size);
    this.cosine = new Float64Array(size / 2);
    this.sine = new Float64Array(size / 2);
    this.magnitude = new Float64Array(size / 2);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit++) reversed = (reversed << 1) | ((i >> bit) & 1);
      this.reverse[i] = reversed;
    }
    for (let i = 0; i < size / 2; i++) {
      this.cosine[i] = Math.cos(2 * Math.PI * i / size);
      this.sine[i] = -Math.sin(2 * Math.PI * i / size);
    }
  }

  transform(samples: Float32Array, start: number): Float64Array {
    const { size, real, imaginary } = this;
    for (let i = 0; i < size; i++) {
      const position = start + i;
      real[this.reverse[i]] = (position >= 0 && position < samples.length ? samples[position] : 0) * this.window[i];
      imaginary[i] = 0;
    }
    for (let length = 2; length <= size; length *= 2) {
      const half = length / 2;
      const step = size / length;
      for (let base = 0; base < size; base += length) {
        for (let offset = 0; offset < half; offset++) {
          const left = base + offset;
          const right = left + half;
          const twiddle = offset * step;
          const r = real[right] * this.cosine[twiddle] - imaginary[right] * this.sine[twiddle];
          const im = real[right] * this.sine[twiddle] + imaginary[right] * this.cosine[twiddle];
          real[right] = real[left] - r;
          imaginary[right] = imaginary[left] - im;
          real[left] += r;
          imaginary[left] += im;
        }
      }
    }
    for (let i = 0; i < size / 2; i++) this.magnitude[i] = Math.hypot(real[i], imaginary[i]);
    return this.magnitude;
  }
}

function extractSpectrum(samples: Float32Array, sampleRate: number, report: (progress: number, stage: string) => void): SpectrumFrame[] {
  const fft = new Spectrum(sampleRate);
  const hop = fft.size / 4;
  const count = Math.ceil(samples.length / hop);
  const frames: SpectrumFrame[] = [];
  const lowBin = Math.max(2, Math.floor(60 * fft.size / sampleRate));
  const highBin = Math.min(fft.size / 2 - 2, Math.ceil(2200 * fft.size / sampleRate));

  for (let frame = 0; frame < count; frame++) {
    const center = frame * hop;
    const magnitudes = fft.transform(samples, center - fft.size / 2);
    let squareSum = 0;
    let energyCount = 0;
    for (let j = Math.max(0, center - hop / 2); j < Math.min(samples.length, center + hop / 2); j++) {
      squareSum += samples[j] ** 2;
      energyCount++;
    }
    let arithmetic = 0;
    let geometric = 0;
    let maximum = 0;
    for (let bin = lowBin; bin <= highBin; bin++) {
      const power = magnitudes[bin] ** 2 + 1e-16;
      arithmetic += power;
      geometric += Math.log(power);
      maximum = Math.max(maximum, magnitudes[bin]);
    }
    const bins = highBin - lowBin + 1;
    const flatness = Math.exp(geometric / bins) / (arithmetic / bins);
    const chroma = new Float64Array(12);
    for (let bin = lowBin; bin <= highBin; bin++) {
      const magnitude = magnitudes[bin];
      if (magnitude < maximum * 0.025 || magnitude <= magnitudes[bin - 1] || magnitude < magnitudes[bin + 1]) continue;
      // Interpolate spectral peaks before assigning pitches, so detuning and FFT
      // bin positions do not arbitrarily move energy to a neighbouring note.
      const left = Math.log(magnitudes[bin - 1] + 1e-12);
      const middle = Math.log(magnitude + 1e-12);
      const right = Math.log(magnitudes[bin + 1] + 1e-12);
      const divisor = left - 2 * middle + right;
      const offset = divisor ? clamp(0.5 * (left - right) / divisor, -0.5, 0.5) : 0;
      const frequency = (bin + offset) * sampleRate / fft.size;
      const midi = 69 + 12 * Math.log2(frequency / 440);
      const nearest = Math.round(midi);
      if (nearest < 35 || nearest > 96 || Math.abs(midi - nearest) > 0.46) continue;
      const note = ((nearest % 12) + 12) % 12;
      // Mild low-frequency weighting reduces upper-harmonic domination.
      chroma[note] += magnitude * clamp((180 / frequency) ** 0.25, 0.45, 1.8);
    }
    const total = chroma.reduce((sum, value) => sum + value, 0);
    if (total > 0) for (let note = 0; note < 12; note++) chroma[note] /= total;
    frames.push({ time: center / sampleRate, rms: Math.sqrt(squareSum / Math.max(1, energyCount)), flatness, chroma });
    if (frame % 80 === 0) report(0.24 + 0.49 * frame / count, '正在提取音高与和声特征…');
  }
  return frames;
}

interface Onset { time: number; strength: number }
interface Rhythm { bpm: number; beats: number[]; confidence: number }

/** Energy/brightness novelty, autocorrelation, then onset-snapped beat tracking. */
function estimateRhythm(samples: Float32Array, sampleRate: number): Rhythm {
  const hop = Math.max(64, Math.round(sampleRate * 0.01));
  const windowSize = Math.max(hop, Math.round(sampleRate * 0.023));
  const step = hop / sampleRate;
  const count = Math.ceil(samples.length / hop);
  const envelope = new Float64Array(count);
  const novelty = new Float64Array(count);
  const duration = samples.length / sampleRate;
  for (let frame = 0; frame < count; frame++) {
    let energy = 0;
    let brightness = 0;
    const start = frame * hop;
    const end = Math.min(samples.length, start + windowSize);
    let previousSample = start ? samples[start - 1] : 0;
    for (let i = start; i < end; i++) {
      const sample = samples[i];
      energy += sample * sample;
      brightness += (sample - previousSample) ** 2;
      previousSample = sample;
    }
    const length = Math.max(1, end - start);
    envelope[frame] = Math.log1p(100 * Math.sqrt(energy / length)) + 0.5 * Math.log1p(150 * Math.sqrt(brightness / length));
    novelty[frame] = Math.max(0, envelope[frame] - (frame ? envelope[frame - 1] : 0));
  }
  const positive = Float64Array.from(novelty);
  const neighbourhood = Math.round(0.3 / step);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    let mean = 0;
    let neighbours = 0;
    for (let j = Math.max(0, i - neighbourhood); j <= Math.min(count - 1, i + neighbourhood); j++) {
      mean += positive[j];
      neighbours++;
    }
    novelty[i] = Math.max(0, positive[i] - mean / neighbours * 0.8);
    peak = Math.max(peak, novelty[i]);
  }
  if (peak < 0.015 || duration < 3) return { bpm: 0, beats: [], confidence: 0 };
  const onsets: Onset[] = [];
  for (let i = 0; i < count; i++) {
    if (novelty[i] < peak * 0.12 || (i > 0 && novelty[i] < novelty[i - 1]) || (i + 1 < count && novelty[i] <= novelty[i + 1])) continue;
    const onset = { time: Math.min(duration, (i + 0.5) * step), strength: novelty[i] / peak };
    const last = onsets[onsets.length - 1];
    if (last && onset.time - last.time < 0.16) {
      if (onset.strength > last.strength) onsets[onsets.length - 1] = onset;
    } else onsets.push(onset);
  }
  if (onsets.length < 4) return { bpm: 0, beats: [], confidence: 0 };

  const minLag = Math.floor(60 / 200 / step);
  const maxLag = Math.ceil(60 / 55 / step);
  const correlation = new Float64Array(maxLag * 3 + 2);
  for (let lag = 1; lag < correlation.length; lag++) {
    let product = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let i = lag; i < count; i++) {
      product += novelty[i] * novelty[i - lag];
      leftEnergy += novelty[i] ** 2;
      rightEnergy += novelty[i - lag] ** 2;
    }
    correlation[lag] = product / (Math.sqrt(leftEnergy * rightEnergy) + 1e-12);
  }
  const candidates: { lag: number; score: number }[] = [];
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (correlation[lag] < correlation[lag - 1] || correlation[lag] < correlation[lag + 1]) continue;
    const score = correlation[lag] + 0.3 * correlation[lag * 2] + 0.15 * correlation[lag * 3];
    candidates.push({ lag, score });
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (!bestLag || bestScore < 0.20) return { bpm: 0, beats: [], confidence: 0 };
  const allGaps = onsets.slice(1).map((onset, i) => onset.time - onsets[i].time);
  const typicalGap = median(allGaps);
  const regularGaps = allGaps.filter(gap => Math.abs(gap - typicalGap) < typicalGap * 0.12);
  const parityStrength = [0, 1].map(parity => {
    const group = onsets.filter((_, index) => index % 2 === parity);
    return group.reduce((sum, onset) => sum + onset.strength, 0) / Math.max(1, group.length);
  });
  const alternatingAccent = Math.max(...parityStrength) / Math.max(1e-9, Math.min(...parityStrength));
  const hasDirectRegularPulse = regularGaps.length >= 6 && regularGaps.length / allGaps.length >= 0.6
    && alternatingAccent < 1.2
    && typicalGap >= 60 / 200 && typicalGap <= 60 / 55;
  const periodAtLag = (lag: number) => {
    const left = correlation[lag - 1];
    const center = correlation[lag];
    const right = correlation[lag + 1];
    const denominator = left - 2 * center + right;
    const offset = denominator ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5) : 0;
    return (lag + offset) * step;
  };
  if (!hasDirectRegularPulse && 60 / (bestLag * step) > 135) {
    // In arranged music, subdivisions often make the autocorrelation peak at
    // twice the perceived tempo. Resolve only a strongly supported 2:1 pair;
    // an actually regular fast pulse is retained by the onset-gap check above.
    const halfTempo = candidates
      .filter(candidate => Math.abs(candidate.lag / bestLag - 2) < 0.14)
      .sort((a, b) => b.score - a.score)[0];
    if (halfTempo && halfTempo.score >= bestScore * 0.8 && correlation[halfTempo.lag] >= correlation[bestLag] * 0.85) {
      bestLag = halfTempo.lag;
    }
  }
  let period = periodAtLag(bestLag);
  // A very regular observed pulse is stronger evidence than an autocorrelation
  // octave alias, especially when a fast period lies halfway between two bins.
  if (hasDirectRegularPulse) {
    period = regularGaps.reduce((sum, gap) => sum + gap, 0) / regularGaps.length;
  } else if (duration >= 8) {
    // Integer autocorrelation bins are still a few milliseconds wide at slow
    // tempi. Search only around the selected candidate and keep phase separate.
    const basePeriod = period;
    const radius = Math.max(1, Math.round(0.018 / step));
    let refinedPeriod = period;
    let refinedScore = -Infinity;
    for (let delta = 0; delta <= 30; delta++) {
      for (const direction of delta ? [-1, 1] : [0]) {
        const candidatePeriod = basePeriod * (1 + direction * delta * 0.0005);
        for (const onset of onsets.slice(0, 80)) {
          const candidatePhase = onset.time % candidatePeriod;
          let score = 0;
          let total = 0;
          for (let expected = candidatePhase; expected < duration; expected += candidatePeriod) {
            const frame = Math.round(expected / step);
            let value = 0;
            for (let i = Math.max(0, frame - radius); i <= Math.min(count - 1, frame + radius); i++) {
              value = Math.max(value, novelty[i]);
            }
            score += value;
            total++;
          }
          score /= Math.max(1, total);
          if (score > refinedScore) { refinedScore = score; refinedPeriod = candidatePeriod; }
        }
      }
    }
    period = refinedPeriod;
  }
  if (period < 60 / 205 || period > 60 / 50) return { bpm: 0, beats: [], confidence: 0 };
  let phase = onsets[0].time % period;
  let phaseScore = -1;
  for (const candidate of onsets.slice(0, 160)) {
    const candidatePhase = candidate.time % period;
    let score = 0;
    for (const onset of onsets) {
      const distance = Math.abs(((onset.time - candidatePhase + period / 2) % period + period) % period - period / 2);
      score += onset.strength * Math.max(0, 1 - distance / (period * 0.2));
    }
    if (score > phaseScore) { phaseScore = score; phase = candidatePhase; }
  }
  const beats: number[] = [];
  let cursor = 0;
  let expected = phase;
  while (expected < duration) {
    while (cursor < onsets.length && onsets[cursor].time < expected - period * 0.22) cursor++;
    let actual = expected;
    let score = 0;
    for (let i = cursor; i < onsets.length && onsets[i].time <= expected + period * 0.22; i++) {
      const match = onsets[i].strength * (1 - Math.abs(onsets[i].time - expected) / (period * 0.3));
      if (match > score) { score = match; actual = onsets[i].time; }
    }
    const last = beats[beats.length - 1];
    if (actual >= 0 && actual < duration && (last === undefined || actual > last + period * 0.45)) beats.push(actual);
    expected += period;
  }
  return { bpm: Math.round(60 / period), beats, confidence: clamp(bestScore / 1.45, 0, 0.9) };
}

const TEMPLATES = Array.from({ length: 24 }, (_, index) => {
  const root = index % 12;
  return { label: NOTES[root] + (index >= 12 ? 'm' : ''), notes: [root, (root + (index >= 12 ? 3 : 4)) % 12, (root + 7) % 12] };
});

function inferChords(frames: SpectrumFrame[], duration: number): { chords: ChordSegment[]; key: string; confidence: number } {
  const sortedRms = frames.map(frame => frame.rms).sort((a, b) => a - b);
  const silence = Math.max(1e-5, (sortedRms[Math.floor(sortedRms.length * 0.9)] || 0) * 0.022);
  const states = 25;
  const emissions: Float64Array[] = [];
  const confidences: number[] = [];
  const globalChroma = new Float64Array(12);
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const scores = new Float64Array(states);
    const chroma = new Float64Array(12);
    for (let neighbour = Math.max(0, index - 2); neighbour <= Math.min(frames.length - 1, index + 2); neighbour++) {
      const weight = 3 - Math.abs(neighbour - index);
      for (let note = 0; note < 12; note++) chroma[note] += frames[neighbour].chroma[note] * weight;
    }
    const total = chroma.reduce((sum, value) => sum + value, 0);
    if (total) for (let note = 0; note < 12; note++) chroma[note] /= total;
    const norm = Math.sqrt(chroma.reduce((sum, value) => sum + value ** 2, 0));
    let best = 0;
    let second = 0;
    let bestCoverage = 0;
    let bestSupport = 0;
    for (let state = 0; state < 24; state++) {
      const [root, third, fifth] = TEMPLATES[state].notes;
      const coverage = chroma[root] + chroma[third] + chroma[fifth];
      const support = Math.min(chroma[root], chroma[third], chroma[fifth]);
      const cosine = (chroma[root] + 0.9 * chroma[third] + 0.75 * chroma[fifth]) / (norm * Math.sqrt(2.3725) + 1e-12);
      scores[state] = 0.8 * cosine + 0.2 * coverage - (support < 0.025 ? 0.15 : 0);
      if (scores[state] > best) {
        second = best; best = scores[state]; bestCoverage = coverage; bestSupport = support;
      } else second = Math.max(second, scores[state]);
    }
    const quiet = frame.rms < silence || total < 1e-12;
    const nonTonal = frame.flatness > 0.42;
    const ambiguous = bestSupport < 0.025 || (best - second < 0.02 && bestCoverage < 0.65);
    scores[24] = quiet || nonTonal ? 1.3 : ambiguous ? 0.78 : 0.42;
    if (quiet || nonTonal) for (let state = 0; state < 24; state++) scores[state] *= 0.25;
    const confidence = quiet || nonTonal ? 0 : clamp(bestCoverage * (1 - frame.flatness) * (0.42 + 0.48 * clamp((best - second) / 0.2)), 0, 0.9);
    confidences.push(confidence);
    emissions.push(scores);
    if (!quiet && !nonTonal) {
      for (let note = 0; note < 12; note++) globalChroma[note] += chroma[note] * confidence;
    }
  }

  // Viterbi sequence smoothing avoids isolated, rapidly flickering chord labels.
  const history = new Uint8Array(frames.length * states);
  let previous = new Float64Array(states);
  for (let frame = 0; frame < frames.length; frame++) {
    const next = new Float64Array(states);
    for (let state = 0; state < states; state++) {
      let best = -Infinity;
      let from = state;
      for (let predecessor = 0; predecessor < states; predecessor++) {
        const transition = predecessor === state ? 0 : (predecessor === 24 || state === 24 ? 0.80 : 0.95);
        const score = previous[predecessor] - transition;
        if (score > best) { best = score; from = predecessor; }
      }
      next[state] = best + emissions[frame][state];
      history[frame * states + state] = from;
    }
    previous = next;
  }
  let state = previous.indexOf(Math.max(...previous));
  const path = new Uint8Array(frames.length);
  for (let frame = frames.length - 1; frame >= 0; frame--) {
    path[frame] = state;
    state = history[frame * states + state];
  }
  const chords: ChordSegment[] = [];
  const step = frames.length > 1 ? frames[1].time - frames[0].time : duration;
  for (let start = 0; start < path.length;) {
    let end = start + 1;
    while (end < path.length && path[end] === path[start]) end++;
    const chord = path[start] === 24 ? 'N' : TEMPLATES[path[start]].label;
    let confidence = 0;
    for (let frame = start; frame < end; frame++) confidence += confidences[frame];
    chords.push({
      id: `chord-${chords.length}`,
      start: start === 0 ? 0 : Math.max(0, frames[start].time - step / 2),
      end: end === path.length ? duration : Math.min(duration, frames[end].time - step / 2),
      chord,
      confidence: chord === 'N' ? 0 : confidence / (end - start),
    });
    start = end;
  }

  const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  let key = '未知';
  let bestKey = -Infinity;
  const chromaMean = globalChroma.reduce((sum, value) => sum + value, 0) / 12;
  if (chromaMean > 0) {
    for (let mode = 0; mode < 2; mode++) {
      const profile = mode ? minorProfile : majorProfile;
      const mean = profile.reduce((sum, value) => sum + value, 0) / 12;
      const profileNorm = Math.sqrt(profile.reduce((sum, value) => sum + (value - mean) ** 2, 0));
      for (let root = 0; root < 12; root++) {
        let score = 0;
        for (let note = 0; note < 12; note++) score += (globalChroma[(root + note) % 12] - chromaMean) * (profile[note] - mean) / profileNorm;
        if (score > bestKey) { bestKey = score; key = `${NOTES[root]} ${mode ? 'minor' : 'major'}`; }
      }
    }
  }
  const confidence = chords.reduce((sum, segment) => sum + segment.confidence * (segment.end - segment.start), 0) / duration;
  if (confidence < 0.18) key = '未知';
  return { chords, key, confidence };
}

/** Pure computation used by the worker and synthetic signal tests. */
export function analyzeSamples(samples: Float32Array, sampleRate: number, onProgress?: (progress: AnalysisProgress) => void): SongAnalysis {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('不支持的音频采样率。');
  const duration = samples.length / sampleRate;
  if (!samples.length || duration < 0.25) throw new Error('音频太短，请选择至少 0.25 秒的音频。');
  if (duration > MAX_AUDIO_DURATION) throw new Error('请使用 10 分钟以内的音频，或先裁剪需要练习的片段。');
  const report = (progress: number, stage: string) => onProgress?.({ progress, stage });
  report(0.20, '正在生成波形…');
  const waveform: number[] = [];
  const bins = Math.min(640, samples.length);
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * samples.length / bins);
    const end = Math.floor((bin + 1) * samples.length / bins);
    let squares = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      if (!Number.isFinite(samples[i])) throw new Error('音频包含无效的采样数据。');
      squares += samples[i] ** 2;
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    waveform.push(Math.sqrt(squares / (end - start)) * 0.7 + peak * 0.3);
  }
  const maximum = Math.max(...waveform);
  if (maximum > 0) for (let i = 0; i < waveform.length; i++) waveform[i] /= maximum;
  const frames = extractSpectrum(samples, sampleRate, report);
  report(0.76, '正在估计速度与节拍位置…');
  const rhythm = estimateRhythm(samples, sampleRate);
  report(0.86, '正在平滑和弦并估计调性…');
  const harmony = inferChords(frames, duration);
  report(0.99, '本地分析完成');
  return {
    duration,
    bpm: rhythm.bpm,
    beats: rhythm.beats,
    waveform,
    chords: harmony.chords,
    key: harmony.key,
    confidence: harmony.confidence,
    algorithm: '本地 DSP 估计 · FFT 色度 / 大小三和弦模板 / 起音节拍跟踪；复杂编曲可能不准确',
  };
}
