import type { MelodyNote } from '../types';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

export const GAME_SAMPLE_RATE = 44_100;
export const GAME_CHUNK_SECONDS = 20;
export const GAME_OVERLAP_SECONDS = 4;
export const GAME_D3PM_STEPS = 8;
export const GAME_BOUNDARY_THRESHOLD = 0.15;
export const GAME_PRESENCE_THRESHOLD = 0.2;

const GAME_BOUNDARY_RADIUS = 2;
const MIN_NOTE_DURATION = 0.045;
const DEFAULT_NOTE_CONFIDENCE = 0.9;

type Ort = typeof import('onnxruntime-web/wasm');
type Session = import('onnxruntime-web').InferenceSession;
type Tensor = import('onnxruntime-web').Tensor;

export type GameLanguage = 'universal' | 'en' | 'ja' | 'yue' | 'zh';

const LANGUAGE_IDS: Record<GameLanguage, bigint> = {
  universal: 0n,
  en: 1n,
  ja: 2n,
  yue: 3n,
  zh: 4n,
};

interface GameSessions {
  encoder: Session;
  segmenter: Session;
  boundaryToDuration: Session;
  estimator: Session;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function roundTime(value: number): number {
  return Number(value.toFixed(3));
}

function dispose(tensor: Tensor | undefined): void {
  try { tensor?.dispose(); } catch { /* CPU tensors may already have been released with the session. */ }
}

async function releaseSessions(sessions: Partial<GameSessions>): Promise<void> {
  await Promise.all(Object.values(sessions).map(session => session.release().catch(() => undefined)));
}

async function createSessions(ort: Ort): Promise<GameSessions> {
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, globalThis.location.href).href };
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1))
    : 1;
  const root = `${import.meta.env.BASE_URL}models/game`;
  const options: import('onnxruntime-web').InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
  };
  const sessions: Partial<GameSessions> = {};
  try {
    sessions.encoder = await ort.InferenceSession.create(`${root}/encoder.onnx`, options);
    sessions.segmenter = await ort.InferenceSession.create(`${root}/segmenter.onnx`, options);
    sessions.boundaryToDuration = await ort.InferenceSession.create(`${root}/bd2dur.onnx`, options);
    sessions.estimator = await ort.InferenceSession.create(`${root}/estimator.onnx`, options);
    return sessions as GameSessions;
  } catch (error) {
    await releaseSessions(sessions);
    throw error;
  }
}

/** Resolve chunk-edge overlap while retaining every distinct model boundary. */
export function normalizeMonophonicNotes(notes: readonly MelodyNote[], audioDuration = Infinity): MelodyNote[] {
  const ordered = notes
    .filter(note => Number.isFinite(note.start)
      && Number.isFinite(note.duration)
      && Number.isFinite(note.midi)
      && note.start >= 0
      && note.duration > 0
      && note.start < audioDuration
      && note.midi >= 0
      && note.midi <= 127)
    .map(note => ({
      ...note,
      start: roundTime(note.start),
      duration: roundTime(Math.min(note.duration, audioDuration - note.start)),
      midi: Math.round(note.midi),
      confidence: Number(clamp(note.confidence, 0, 1).toFixed(3)),
      strength: Number(clamp(note.strength, 0, 1).toFixed(3)),
    }))
    .sort((left, right) => left.start - right.start || right.confidence - left.confidence);

  const deduplicated: MelodyNote[] = [];
  for (const note of ordered) {
    const previous = deduplicated.at(-1);
    if (previous && Math.abs(note.start - previous.start) < 0.005) {
      if (note.confidence > previous.confidence
        || (note.confidence === previous.confidence && note.duration > previous.duration)) {
        deduplicated[deduplicated.length - 1] = note;
      }
      continue;
    }
    deduplicated.push(note);
  }

  const result: MelodyNote[] = [];
  for (const note of deduplicated) {
    const previous = result.at(-1);
    if (previous && previous.start + previous.duration > note.start) {
      previous.duration = roundTime(note.start - previous.start);
      if (previous.duration < MIN_NOTE_DURATION) result.pop();
    }
    if (note.duration >= MIN_NOTE_DURATION) result.push(note);
  }
  return result;
}

async function inferChunk(
  ort: Ort,
  sessions: GameSessions,
  waveform: Float32Array,
  languageId: bigint,
): Promise<MelodyNote[]> {
  const sampleCount = waveform.length;
  const waveformTensor = new ort.Tensor('float32', waveform, [1, sampleCount]);
  const durationTensor = new ort.Tensor(
    'float32',
    Float32Array.of(sampleCount / GAME_SAMPLE_RATE),
    [1],
  );
  let xSeg: Tensor | undefined;
  let xEst: Tensor | undefined;
  let maskT: Tensor | undefined;
  let knownBoundaries: Tensor | undefined;
  let boundaries: Tensor | undefined;
  let durations: Tensor | undefined;
  let maskN: Tensor | undefined;
  let presence: Tensor | undefined;
  let scores: Tensor | undefined;

  try {
    const encoded = await sessions.encoder.run({ waveform: waveformTensor, duration: durationTensor });
    xSeg = encoded.x_seg;
    xEst = encoded.x_est;
    maskT = encoded.maskT;
    knownBoundaries = new ort.Tensor('bool', new Uint8Array(maskT.data.length), maskT.dims);
    let currentBoundaries: Tensor = knownBoundaries;
    boundaries = currentBoundaries;

    const language = new ort.Tensor('int64', BigInt64Array.of(languageId), [1]);
    const threshold = new ort.Tensor('float32', Float32Array.of(GAME_BOUNDARY_THRESHOLD), []);
    const radius = new ort.Tensor('int64', BigInt64Array.of(BigInt(GAME_BOUNDARY_RADIUS)), []);
    try {
      for (let step = 0; step < GAME_D3PM_STEPS; step++) {
        const time = new ort.Tensor('float32', Float32Array.of(step / GAME_D3PM_STEPS), [1]);
        const previousBoundaries: Tensor = currentBoundaries;
        try {
          const segmented = await sessions.segmenter.run({
            x_seg: xSeg,
            language,
            known_boundaries: knownBoundaries,
            prev_boundaries: previousBoundaries,
            t: time,
            maskT,
            threshold,
            radius,
          }) as { boundaries: Tensor };
          currentBoundaries = segmented.boundaries;
          boundaries = currentBoundaries;
        } finally {
          dispose(time);
          if (previousBoundaries !== knownBoundaries) dispose(previousBoundaries);
        }
      }
    } finally {
      dispose(language);
      dispose(threshold);
      dispose(radius);
    }

    const converted = await sessions.boundaryToDuration.run({
      boundaries: currentBoundaries,
      maskT,
    });
    durations = converted.durations;
    maskN = converted.maskN;
    const presenceThreshold = new ort.Tensor(
      'float32',
      Float32Array.of(GAME_PRESENCE_THRESHOLD),
      [],
    );
    try {
      const estimated = await sessions.estimator.run({
        x_est: xEst,
        boundaries: currentBoundaries,
        maskT,
        maskN,
        threshold: presenceThreshold,
      });
      presence = estimated.presence;
      scores = estimated.scores;
    } finally {
      dispose(presenceThreshold);
    }

    const durationData = durations.data as Float32Array;
    const maskData = maskN.data as Uint8Array;
    const presenceData = presence.data as Uint8Array;
    const scoreData = scores.data as Float32Array;
    const notes: MelodyNote[] = [];
    let onset = 0;
    for (let index = 0; index < durationData.length; index++) {
      const duration = durationData[index];
      if (maskData[index] && presenceData[index] && duration >= MIN_NOTE_DURATION) {
        notes.push({
          start: roundTime(onset),
          duration: roundTime(duration),
          midi: Math.round(scoreData[index]),
          confidence: DEFAULT_NOTE_CONFIDENCE,
          strength: DEFAULT_NOTE_CONFIDENCE,
        });
      }
      onset += duration;
    }
    return notes;
  } finally {
    dispose(waveformTensor);
    dispose(durationTensor);
    dispose(xSeg);
    dispose(xEst);
    dispose(maskT);
    dispose(knownBoundaries);
    if (boundaries !== knownBoundaries) dispose(boundaries);
    dispose(durations);
    dispose(maskN);
    dispose(presence);
    dispose(scores);
  }
}

/** GAME singing-note inference, chunked to bound the transformer's quadratic memory use. */
export async function transcribeGameMelody(
  samples: Float32Array,
  onProgress?: (progress: number) => void,
  language: GameLanguage = 'universal',
): Promise<MelodyNote[]> {
  if (!(samples instanceof Float32Array) || !samples.length) return [];
  const ort = await import('onnxruntime-web/wasm');
  onProgress?.(0.01);
  const sessions = await createSessions(ort);
  const chunkSamples = Math.round(GAME_CHUNK_SECONDS * GAME_SAMPLE_RATE);
  const overlapSamples = Math.round(GAME_OVERLAP_SECONDS * GAME_SAMPLE_RATE);
  const strideSamples = chunkSamples - overlapSamples;
  const chunkStarts: number[] = [];
  for (let start = 0; start < samples.length; start += strideSamples) {
    chunkStarts.push(start);
    if (start + chunkSamples >= samples.length) break;
  }
  const notes: MelodyNote[] = [];
  try {
    for (let index = 0; index < chunkStarts.length; index++) {
      const start = chunkStarts[index];
      const end = Math.min(samples.length, start + chunkSamples);
      const chunk = samples.slice(start, end);
      const inferred = await inferChunk(ort, sessions, chunk, LANGUAGE_IDS[language]);
      const chunkDuration = chunk.length / GAME_SAMPLE_RATE;
      const leftMargin = index === 0 ? 0 : GAME_OVERLAP_SECONDS / 2;
      const rightMargin = end === samples.length
        ? chunkDuration
        : GAME_CHUNK_SECONDS - GAME_OVERLAP_SECONDS / 2;
      const offset = start / GAME_SAMPLE_RATE;
      for (const note of inferred) {
        if (note.start < leftMargin || note.start >= rightMargin) continue;
        notes.push({ ...note, start: roundTime(note.start + offset) });
      }
      onProgress?.((index + 1) / chunkStarts.length);
    }
  } finally {
    await releaseSessions(sessions);
  }
  return normalizeMonophonicNotes(notes, samples.length / GAME_SAMPLE_RATE);
}
