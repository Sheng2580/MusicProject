import type { MelodyNote, SongAnalysis } from '../types';

const SAMPLE_RATE = 22050;
const MAX_SOURCE_DURATION = 600;
const MAX_NOTE_SECONDS = 2;
const PEAK_LIMIT = 0.82;
const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

interface Harmony {
  root: number;
  third: number;
}

interface Segment {
  start: number;
  end: number;
  harmony: Harmony | null;
}

function parseHarmony(label: string): Harmony | null {
  if (typeof label !== 'string') return null;
  const match = /^([A-G])([#b♯♭]?)(m|min)?$/.exec(label.trim());
  if (!match) return null;
  const accidental = match[2] === '#' || match[2] === '♯' ? 1 : match[2] ? -1 : 0;
  return { root: (ROOTS[match[1]] + accidental + 12) % 12, third: match[3] ? 3 : 4 };
}

function writeText(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function createWave(frameCount: number): { buffer: ArrayBuffer; view: DataView } {
  const dataBytes = frameCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeText(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(view, 8, 'WAVE');
  writeText(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // Linear PCM.
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return { buffer, view };
}

function validMelody(analysis: SongAnalysis, sourceDuration: number): MelodyNote[] {
  const notes = analysis.melody;
  if (!Array.isArray(notes)) return [];
  return notes.filter(note => Boolean(note)
    && Number.isFinite(note.start) && note.start >= 0 && note.start < sourceDuration
    && Number.isFinite(note.duration) && note.duration > 0
    && Number.isFinite(note.midi) && note.midi >= 24 && note.midi <= 108
    && Number.isFinite(note.confidence) && note.confidence >= 0 && note.confidence <= 1
    && Number.isFinite(note.strength) && note.strength >= 0 && note.strength <= 1)
    .map(note => ({ ...note, duration: Math.min(note.duration, sourceDuration - note.start) }))
    .filter(note => note.duration > 0)
    .sort((left, right) => left.start - right.start || right.strength - left.strength);
}

/** Add one softly plucked harmonic tone; the last sample is always silent. */
function addTone(
  samples: Float32Array,
  offset: number,
  length: number,
  midi: number,
  amplitude: number,
  bass: boolean,
): void {
  if (length < 2) return;
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  const angle = 2 * Math.PI * frequency / SAMPLE_RATE;
  const stepSin = Math.sin(angle);
  const stepCos = Math.cos(angle);
  const attack = Math.max(1, Math.min(length / 4, SAMPLE_RATE * (bass ? 0.012 : 0.009)));
  const release = Math.max(1, Math.min(length / 3, SAMPLE_RATE * 0.045));
  const decay = Math.exp(-1 / (SAMPLE_RATE * (bass ? 0.34 : 0.28)));
  const secondPartial = bass ? 0.12 : 0.2;
  const thirdPartial = bass ? 0.025 : 0.05;
  const level = amplitude / (1 + secondPartial + thirdPartial);
  let sine = 0;
  let cosine = 1;
  let sustain = 1;

  for (let i = 0; i < length; i++) {
    const envelope = Math.min(1, i / attack, (length - 1 - i) / release) * sustain;
    // Angle identities produce a few soft partials without per-sample trig calls.
    const second = 2 * sine * cosine;
    const third = 3 * sine - 4 * sine * sine * sine;
    samples[offset + i] += level * envelope * (sine + secondPartial * second + thirdPartial * third);
    const nextSine = sine * stepCos + cosine * stepSin;
    cosine = cosine * stepCos - sine * stepSin;
    sine = nextSine;
    sustain *= decay;
  }
}

function addMelodyTone(samples: Float32Array, length: number, midi: number, amplitude: number, variation: number): void {
  addTone(samples, 0, length, midi, amplitude, false);
  const transientLength = Math.min(length, Math.ceil(SAMPLE_RATE * 0.018));
  let seed = (Math.round(midi * 1543) + Math.imul(variation + 1, 7919)) | 0;
  let previous = 0;
  for (let i = 0; i < transientLength; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const noise = (seed >>> 0) / 4294967296 * 2 - 1;
    const pick = noise - previous;
    previous = noise;
    const time = i / SAMPLE_RATE;
    const attack = Math.min(1, time / 0.0012);
    samples[i] += pick * amplitude * 0.065 * attack * Math.exp(-time / 0.0045);
  }
}

/**
 * Synthesize an approximate instrumental backing from analysis alone.
 * This does not remove vocals or reuse any original recording. Rendering uses
 * no AudioContext, and retains only a short floating-point scratch window plus
 * the final mono PCM buffer (about 26.5 MB for a ten-minute song, or 53 MB at
 * half speed). Slow practice changes event timing, never note frequencies.
 */
export function renderAccompaniment(analysis: SongAnalysis, practiceRate = 1): Blob {
  const rate = Number.isFinite(practiceRate) ? Math.max(0.5, Math.min(1, practiceRate)) : 1;
  const sourceDuration = Number.isFinite(analysis.duration) ? Math.max(0, Math.min(MAX_SOURCE_DURATION, analysis.duration)) : 0;
  const duration = sourceDuration / rate;
  const frameCount = Math.round(duration * SAMPLE_RATE);
  const { buffer, view } = createWave(frameCount);
  const result = () => new Blob([buffer], { type: 'audio/wav' });
  if (!frameCount) return result();
  const melody = validMelody(analysis, sourceDuration);

  const beatFrames = [...new Set((Array.isArray(analysis.beats) ? analysis.beats : [])
    .filter(time => Number.isFinite(time) && time >= 0 && time < sourceDuration)
    .map(time => Math.ceil(time / rate * SAMPLE_RATE)))]
    .filter(frame => frame < frameCount)
    .sort((a, b) => a - b);

  const segments: Segment[] = (Array.isArray(analysis.chords) ? analysis.chords : [])
    .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .map(segment => ({
      start: Math.max(0, segment.start) / rate,
      end: Math.min(sourceDuration, segment.end) / rate,
      harmony: parseHarmony(segment.chord),
    }))
    .filter(segment => segment.start < duration && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  if (Number.isFinite(analysis.bpm) && analysis.bpm > 0 && beatFrames.length && segments.length) {
    const beatSeconds = Math.max(0.08, Math.min(MAX_NOTE_SECONDS, 60 / (analysis.bpm * rate)));
    const scratch = new Float32Array(Math.min(frameCount, Math.ceil(MAX_NOTE_SECONDS * SAMPLE_RATE)));
    // A detected chord grid is useful as a legacy fallback, but even one wrong
    // triad masks the tune. Once a melody transcription exists, keep this
    // render strictly monophonic and let a real backing stem supply harmony.
    const harmonyLevel = melody.length ? 0 : 1;
    let segmentIndex = 0;

    for (let beatIndex = 0; beatIndex < beatFrames.length; beatIndex++) {
      const startFrame = beatFrames[beatIndex];
      const time = startFrame / SAMPLE_RATE;
      while (segmentIndex + 1 < segments.length && segments[segmentIndex + 1].start <= time) segmentIndex++;
      const segment = segments[segmentIndex];
      if (time < segment.start || time >= segment.end || !segment.harmony) continue;

      // End every tone before another beat or chord begins, including N sections.
      const endFrame = Math.min(
        frameCount,
        beatFrames[beatIndex + 1] ?? frameCount,
        Math.ceil(segment.end * SAMPLE_RATE),
        Math.ceil((segments[segmentIndex + 1]?.start ?? duration) * SAMPLE_RATE),
        startFrame + Math.ceil(beatSeconds * SAMPLE_RATE),
      );
      const count = Math.min(scratch.length, endFrame - startFrame);
      if (count < 2) continue;
      scratch.fill(0, 0, count);

      const { root, third } = segment.harmony;
      const accent = beatIndex % 4 === 0 ? 1 : 0.84;
      addTone(scratch, 0, Math.max(2, Math.floor(count * 0.9)), 36 + root, 0.15 * accent * harmonyLevel, true);
      const notes = beatIndex % 2 === 0 ? [60 + root, 60 + root + third, 67 + root] : [67 + root, 60 + root + third, 60 + root];
      for (let note = 0; note < notes.length; note++) {
        const offset = Math.round(Math.min(0.012 * note, count / SAMPLE_RATE * 0.12 * note) * SAMPLE_RATE);
        addTone(scratch, offset, count - offset, notes[note], (note === 0 ? 0.065 : 0.05) * accent * harmonyLevel, false);
      }

      // Normalize downward only: preserve the restrained dynamics of soft beats.
      let peak = 0;
      for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(scratch[i]));
      const gain = peak > PEAK_LIMIT ? PEAK_LIMIT / peak : 1;
      for (let i = 0; i < count; i++) {
        const value = Number.isFinite(scratch[i]) ? scratch[i] * gain : 0;
        view.setInt16(44 + (startFrame + i) * 2, Math.round(Math.max(-PEAK_LIMIT, Math.min(PEAK_LIMIT, value)) * 32767), true);
      }
    }
  }

  if (melody.length) {
    const scratch = new Float32Array(Math.min(frameCount, Math.ceil(MAX_NOTE_SECONDS * SAMPLE_RATE)));
    for (let noteIndex = 0; noteIndex < melody.length; noteIndex++) {
      const note = melody[noteIndex];
      const startFrame = Math.ceil(note.start / rate * SAMPLE_RATE);
      const naturalEnd = Math.ceil((note.start + note.duration) / rate * SAMPLE_RATE);
      const nextStart = melody[noteIndex + 1]?.start;
      const nextLimit = nextStart === undefined ? frameCount : Math.ceil(nextStart / rate * SAMPLE_RATE + SAMPLE_RATE * 0.025);
      const endFrame = Math.min(frameCount, naturalEnd, nextLimit, startFrame + scratch.length);
      const count = endFrame - startFrame;
      if (count < 2) continue;
      scratch.fill(0, 0, count);
      const amplitude = (0.28 + 0.14 * note.strength) * (0.8 + 0.2 * note.confidence);
      addMelodyTone(scratch, count, note.midi, amplitude, noteIndex % 4);
      for (let i = 0; i < count; i++) {
        const offset = 44 + (startFrame + i) * 2;
        const existing = view.getInt16(offset, true) / 32767;
        const value = existing + (Number.isFinite(scratch[i]) ? scratch[i] : 0);
        view.setInt16(offset, Math.round(Math.max(-PEAK_LIMIT, Math.min(PEAK_LIMIT, value)) * 32767), true);
      }
    }
  }

  return result();
}
