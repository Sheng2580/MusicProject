import type { MelodyNote } from '../types';
import type { BasicPitch, NoteEventTime } from '@spotify/basic-pitch';
import basicPitchWasmUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import basicPitchWasmSimdUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import basicPitchWasmThreadedSimdUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';
import {
  GAME_SAMPLE_RATE,
  normalizeMonophonicNotes,
  transcribeGameMelody,
} from './gameTranscription';

export const MELODY_MODEL_SAMPLE_RATE = GAME_SAMPLE_RATE;
export const MELODY_TRANSCRIPTION_ALGORITHM = 'OpenVPI GAME 歌声逐音转录 / Basic Pitch 器乐空段补全';

const BASIC_PITCH_SAMPLE_RATE = 22_050;
const FFT_HOP = 256;
const MODEL_MIDI_OFFSET = 21;
const MODEL_PITCHES = 88;
const MODEL_WINDOW_FRAMES = Math.floor(BASIC_PITCH_SAMPLE_RATE / FFT_HOP) * 2;
const MODEL_AUDIO_SAMPLES = BASIC_PITCH_SAMPLE_RATE * 2 - FFT_HOP;
const BASIC_PITCH_OVERLAP_SAMPLES = 30 * FFT_HOP;
const BASIC_PITCH_LEADING_PADDING = BASIC_PITCH_OVERLAP_SAMPLES / 2;
const BASIC_PITCH_FRAME_STEP = MODEL_AUDIO_SAMPLES - BASIC_PITCH_OVERLAP_SAMPLES;
const MODEL_WINDOW_OFFSET = FFT_HOP / BASIC_PITCH_SAMPLE_RATE
  * (MODEL_WINDOW_FRAMES - MODEL_AUDIO_SAMPLES / FFT_HOP) + .0018;
const MIN_MELODY_MIDI = 40;
const MAX_MELODY_MIDI = 96;
const SILENCE_STATE = MAX_MELODY_MIDI - MIN_MELODY_MIDI + 1;
const STATE_COUNT = SILENCE_STATE + 1;
const MIN_NOTE_FRAMES = 4;
const WEAK_FLICKER_FRAMES = 10;
const REATTACK_FRAMES = 6;
const STRONG_ONSET_THRESHOLD = .6;
const WEAK_REATTACK_THRESHOLD = .5;
const ACTIVE_FRAME_THRESHOLD = .31;
const INSTRUMENTAL_GAP_SECONDS = 2.2;
const GAP_ANALYSIS_PADDING_SECONDS = .25;
const MIN_OUTPUT_NOTE_SECONDS = .045;
const MIN_INSTRUMENTAL_LEAD_SECONDS = .09;
const MIN_INSTRUMENTAL_LEAD_MIDI = 65;
const MIN_INSTRUMENTAL_STRENGTH = .35;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function frameTime(frame: number): number {
  return Math.max(0, frame * FFT_HOP / BASIC_PITCH_SAMPLE_RATE
    - MODEL_WINDOW_OFFSET * Math.floor(frame / MODEL_WINDOW_FRAMES));
}

function matrixValue(matrix: number[][], frame: number, midi: number): number {
  const value = matrix[frame]?.[midi - MODEL_MIDI_OFFSET];
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function transitionScore(previous: number, next: number, onset: number): number {
  if (previous === next) return .11;
  if (previous === SILENCE_STATE) return -.12 + onset * .54;
  if (next === SILENCE_STATE) return -.16;
  const interval = Math.abs(previous - next);
  if (interval <= 2) return -.025 * interval + onset * .36;
  if (interval <= 7) return -.09 - .045 * interval + onset * .42;
  if (interval <= 12) return -.48 - .07 * (interval - 7) + onset * .48;
  return -1.15 - .055 * (interval - 12) + onset * .5;
}

function isLocalOnsetPeak(onsets: number[][], frame: number, midi: number, threshold: number): boolean {
  const onset = matrixValue(onsets, frame, midi);
  return onset >= threshold
    && onset >= matrixValue(onsets, frame - 1, midi)
    && onset > matrixValue(onsets, frame + 1, midi);
}

function peakStateActivity(frames: number[][], state: number, start: number, end: number): number {
  if (state === SILENCE_STATE) return 0;
  const midi = MIN_MELODY_MIDI + state;
  let peak = 0;
  for (let frame = start; frame < end; frame++) peak = Math.max(peak, matrixValue(frames, frame, midi));
  return peak;
}

function isSupportedShortAttack(
  path: Int8Array,
  frames: number[][],
  onsets: number[][],
  start: number,
  end: number,
): boolean {
  const selected = path[start];
  if (selected === SILENCE_STATE || end - start >= MIN_NOTE_FRAMES) return false;
  const midi = MIN_MELODY_MIDI + selected;
  let peakOnset = 0;
  let activity = 0;
  for (let frame = start; frame < end; frame++) {
    peakOnset = Math.max(peakOnset, matrixValue(onsets, frame, midi));
    activity += matrixValue(frames, frame, midi);
  }
  if (peakOnset < STRONG_ONSET_THRESHOLD || activity / (end - start) < ACTIVE_FRAME_THRESHOLD) return false;

  // A real very short pitch change replaces the surrounding voice. If that
  // voice remains active underneath, the upper path is usually a harmonic
  // flicker rather than a separately playable note.
  const adjacent = new Set<number>();
  if (start > 0 && path[start - 1] !== selected) adjacent.add(path[start - 1]);
  if (end < path.length && path[end] !== selected) adjacent.add(path[end]);
  return [...adjacent].every(state => peakStateActivity(frames, state, start, end) < ACTIVE_FRAME_THRESHOLD);
}

function hasRecentActivityValley(frames: number[][], frame: number, midi: number): boolean {
  for (let previous = Math.max(0, frame - 3); previous < frame; previous++) {
    if (matrixValue(frames, previous, midi) < ACTIVE_FRAME_THRESHOLD) return true;
  }
  return false;
}

function smoothDecodedPath(path: Int8Array, frames: number[][], onsets: number[][]): void {
  // Remove weak, short voice changes while retaining genuinely attacked short notes.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let start = 0; start < path.length;) {
      const selected = path[start];
      let end = start + 1;
      while (end < path.length && path[end] === selected) end++;
      const left = start > 0 ? path[start - 1] : SILENCE_STATE;
      const right = end < path.length ? path[end] : SILENCE_STATE;
      if (selected === SILENCE_STATE) {
        if (end - start <= 2 && left === right && left !== SILENCE_STATE) {
          const midi = MIN_MELODY_MIDI + left;
          const resumesWithAttack = end < path.length
            && isLocalOnsetPeak(onsets, end, midi, WEAK_REATTACK_THRESHOLD)
            && matrixValue(frames, end, midi) >= ACTIVE_FRAME_THRESHOLD;
          if (!resumesWithAttack) {
            path.fill(left, start, end);
            changed = true;
          }
        }
      } else if (end - start < WEAK_FLICKER_FRAMES) {
        const midi = MIN_MELODY_MIDI + selected;
        let peakOnset = 0;
        for (let frame = start; frame < end; frame++) {
          peakOnset = Math.max(peakOnset, matrixValue(onsets, frame, midi));
        }
        const unsupportedVeryShortAttack = end - start < MIN_NOTE_FRAMES
          && !isSupportedShortAttack(path, frames, onsets, start, end);
        if (peakOnset < STRONG_ONSET_THRESHOLD || unsupportedVeryShortAttack) {
          const replacement = left === right
            ? left
            : left !== SILENCE_STATE && right === SILENCE_STATE
              ? left
              : left === SILENCE_STATE && right !== SILENCE_STATE
                ? right
                : SILENCE_STATE;
          path.fill(replacement, start, end);
          changed = true;
        }
      }
      start = end;
    }
    if (!changed) break;
  }
}

/** Select one continuous, predominant line from Basic Pitch's polyphonic activations. */
export function decodePredominantMelody(frames: number[][], onsets: number[][]): MelodyNote[] {
  const frameCount = Math.min(frames.length, onsets.length);
  if (!frameCount) return [];
  const backPointers = new Int8Array(frameCount * STATE_COUNT);
  let previous = new Float64Array(STATE_COUNT);
  previous.fill(-6);
  previous[SILENCE_STATE] = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    let maximumActivity = 0;
    let highestSalient = MIN_MELODY_MIDI;
    for (let midi = MIN_MELODY_MIDI; midi <= MAX_MELODY_MIDI; midi++) {
      const activity = matrixValue(frames, frame, midi);
      maximumActivity = Math.max(maximumActivity, activity);
      if (activity >= .27) highestSalient = midi;
    }
    const next = new Float64Array(STATE_COUNT);
    let frameMaximum = -Infinity;
    for (let state = 0; state < STATE_COUNT; state++) {
      const midi = MIN_MELODY_MIDI + state;
      const onset = state === SILENCE_STATE ? 0 : matrixValue(onsets, frame, midi);
      const activity = state === SILENCE_STATE ? 0 : matrixValue(frames, frame, midi);
      const emission = state === SILENCE_STATE
        ? (maximumActivity < .22 ? .34 : maximumActivity < .31 ? .08 : -.52)
        : (activity - .27) * 3.8 + onset * .72
          - Math.max(0, highestSalient - midi) * .06
          - (midi < 52 ? (52 - midi) * .045 : 0);
      let best = -Infinity;
      let bestPrevious = SILENCE_STATE;
      for (let source = 0; source < STATE_COUNT; source++) {
        const candidate = previous[source] + transitionScore(source, state, onset);
        if (candidate > best) { best = candidate; bestPrevious = source; }
      }
      next[state] = best + emission;
      backPointers[frame * STATE_COUNT + state] = bestPrevious;
      frameMaximum = Math.max(frameMaximum, next[state]);
    }
    for (let state = 0; state < STATE_COUNT; state++) next[state] -= frameMaximum;
    previous = next;
  }

  let state = 0;
  for (let candidate = 1; candidate < STATE_COUNT; candidate++) {
    if (previous[candidate] > previous[state]) state = candidate;
  }
  const path = new Int8Array(frameCount);
  for (let frame = frameCount - 1; frame >= 0; frame--) {
    path[frame] = state;
    state = backPointers[frame * STATE_COUNT + state];
  }
  smoothDecodedPath(path, frames, onsets);

  const melody: MelodyNote[] = [];
  for (let start = 0; start < frameCount;) {
    const selected = path[start];
    let end = start + 1;
    while (end < frameCount && path[end] === selected) end++;
    if (selected === SILENCE_STATE) { start = end; continue; }
    const midi = MIN_MELODY_MIDI + selected;
    const boundaries = [start];
    for (let frame = start + REATTACK_FRAMES; frame < end - 1; frame++) {
      const onset = matrixValue(onsets, frame, midi);
      // Basic Pitch leaves a weak secondary peak near many note-offs. Only a
      // strong attack, or a weaker attack after an activity valley, may split
      // a stable pitch into two playable cues.
      const supportedWeakReattack = onset >= WEAK_REATTACK_THRESHOLD
        && hasRecentActivityValley(frames, frame, midi);
      if ((!supportedWeakReattack && onset < STRONG_ONSET_THRESHOLD)
        || !isLocalOnsetPeak(onsets, frame, midi, WEAK_REATTACK_THRESHOLD)) continue;
      if (frame - boundaries[boundaries.length - 1] >= REATTACK_FRAMES) boundaries.push(frame);
    }
    boundaries.push(end);
    for (let index = 0; index + 1 < boundaries.length; index++) {
      const noteStart = boundaries[index];
      const noteEnd = boundaries[index + 1];
      const completePathRun = noteStart === start && noteEnd === end;
      if (noteEnd - noteStart < MIN_NOTE_FRAMES
        && (!completePathRun || !isSupportedShortAttack(path, frames, onsets, start, end))) continue;
      let activity = 0;
      let strength = 0;
      for (let frame = noteStart; frame < noteEnd; frame++) {
        activity += matrixValue(frames, frame, midi);
        strength = Math.max(strength, matrixValue(onsets, frame, midi));
      }
      const startTime = frameTime(noteStart);
      const endTime = frameTime(noteEnd);
      melody.push({
        start: Number(startTime.toFixed(3)),
        duration: Number(Math.max(.045, endTime - startTime).toFixed(3)),
        midi,
        confidence: Number(clamp(activity / (noteEnd - noteStart), 0, 1).toFixed(3)),
        strength: Number(clamp(strength, 0, 1).toFixed(3)),
      });
    }
    start = end;
  }
  return melody;
}

interface TimeRange {
  start: number;
  end: number;
}

type MelodyWorkerMessage =
  | { type: 'progress'; progress: number }
  | { type: 'result'; melody: MelodyNote[] }
  | { type: 'error'; message: string };

interface BasicPitchRuntime {
  model: BasicPitch;
  noteFramesToTime: typeof import('@spotify/basic-pitch').noteFramesToTime;
  outputToNotesPoly: typeof import('@spotify/basic-pitch').outputToNotesPoly;
}

const BASIC_PITCH_WASM_PATHS = {
  'tfjs-backend-wasm.wasm': basicPitchWasmUrl,
  'tfjs-backend-wasm-simd.wasm': basicPitchWasmSimdUrl,
  'tfjs-backend-wasm-threaded-simd.wasm': basicPitchWasmThreadedSimdUrl,
};

let basicPitchBackendInitialization: Promise<void> | undefined;

/** Lazily initializes TensorFlow only when the melody worker needs Basic Pitch. */
export function initializeBasicPitchWasmBackend(): Promise<void> {
  if (!basicPitchBackendInitialization) {
    basicPitchBackendInitialization = Promise.all([
      import('@tensorflow/tfjs'),
      import('@tensorflow/tfjs-backend-wasm'),
    ]).then(async ([tf, wasmBackend]) => {
      wasmBackend.setWasmPaths(BASIC_PITCH_WASM_PATHS);
      // A transcription already runs in its own Worker. A nested WASM thread
      // pool adds memory pressure and requires cross-origin isolation.
      wasmBackend.setThreadsCount(1);
      if (!await tf.setBackend('wasm')) throw new Error('无法启用 TensorFlow WASM 后端。');
      await tf.ready();
    });
  }
  return basicPitchBackendInitialization;
}

/**
 * Matches Basic Pitch 1.0.1 framing without tf.signal.frame's untyped tail
 * fill, which the TensorFlow 3.21 WASM backend cannot execute.
 */
export function frameBasicPitchAudio(
  tf: typeof import('@tensorflow/tfjs'),
  samples: Float32Array,
): import('@tensorflow/tfjs').Tensor3D {
  return tf.tidy(() => {
    const padded = tf.concat1d([
      tf.zeros([BASIC_PITCH_LEADING_PADDING], 'float32'),
      tf.tensor1d(samples, 'float32'),
    ]);
    const frames: import('@tensorflow/tfjs').Tensor1D[] = [];
    for (let start = 0; start < padded.size; start += BASIC_PITCH_FRAME_STEP) {
      const available = Math.min(MODEL_AUDIO_SAMPLES, padded.size - start);
      const signal = tf.slice1d(padded, start, available);
      if (available === MODEL_AUDIO_SAMPLES) frames.push(signal);
      else frames.push(tf.concat1d([
        signal,
        tf.fill([MODEL_AUDIO_SAMPLES - available], 0, 'float32'),
      ]));
    }
    if (!frames.length) return tf.tensor3d([], [0, MODEL_AUDIO_SAMPLES, 1], 'float32');
    return tf.reshape(
      tf.concat1d(frames),
      [frames.length, MODEL_AUDIO_SAMPLES, 1],
    ) as import('@tensorflow/tfjs').Tensor3D;
  });
}

function installBasicPitchWasmCompatibility(
  model: BasicPitch,
  tf: typeof import('@tensorflow/tfjs'),
): void {
  let preparedInput: import('@tensorflow/tfjs').Tensor3D | undefined;
  model.prepareData = async samples => {
    preparedInput?.dispose();
    preparedInput = frameBasicPitchAudio(tf, samples);
    return [preparedInput, samples.length];
  };

  const evaluateModel = model.evaluateModel.bind(model);
  model.evaluateModel = async (...args) => {
    try {
      await evaluateModel(...args);
    } finally {
      preparedInput?.dispose();
      preparedInput = undefined;
    }
  };
}

/** Long regions without a GAME note are the only places where instruments may fill the lead. */
export function findInstrumentalGaps(
  notes: readonly MelodyNote[],
  duration: number,
  minimumGap = INSTRUMENTAL_GAP_SECONDS,
): TimeRange[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const ordered = normalizeMonophonicNotes(notes, duration);
  const gaps: TimeRange[] = [];
  let cursor = 0;
  for (const note of ordered) {
    if (note.start - cursor >= minimumGap) gaps.push({ start: cursor, end: note.start });
    cursor = Math.max(cursor, note.start + note.duration);
  }
  if (duration - cursor >= minimumGap) gaps.push({ start: cursor, end: duration });
  return gaps;
}

function downsampleForBasicPitch(samples: Float32Array): Float32Array {
  const output = new Float32Array(Math.floor(samples.length / 2));
  for (let index = 0; index < output.length; index++) {
    output[index] = (samples[index * 2] + samples[index * 2 + 1]) / 2;
  }
  return output;
}

/** Choose the upper attacked voice from official Basic Pitch polyphonic events. */
export function selectInstrumentalLead(
  events: readonly NoteEventTime[],
  offset: number,
  range: TimeRange,
): MelodyNote[] {
  const candidates = events
    .filter(event => Number.isFinite(event.startTimeSeconds)
      && Number.isFinite(event.durationSeconds)
      && Number.isFinite(event.pitchMidi)
      && event.durationSeconds >= MIN_INSTRUMENTAL_LEAD_SECONDS
      && event.amplitude >= MIN_INSTRUMENTAL_STRENGTH
      && event.pitchMidi >= MIN_INSTRUMENTAL_LEAD_MIDI
      && event.pitchMidi <= MAX_MELODY_MIDI)
    .map(event => ({
      start: event.startTimeSeconds + offset,
      duration: event.durationSeconds,
      midi: Math.round(event.pitchMidi),
      amplitude: clamp(event.amplitude, 0, 1),
    }))
    .filter(event => event.start >= range.start - .04
      && event.start < range.end
      && event.start + event.duration > range.start)
    .sort((left, right) => left.start - right.start || right.midi - left.midi);

  const selected: typeof candidates = [];
  for (let index = 0; index < candidates.length;) {
    let end = index + 1;
    let best = candidates[index];
    while (end < candidates.length && candidates[end].start - candidates[index].start <= .065) {
      const candidate = candidates[end];
      if (candidate.midi > best.midi
        || (candidate.midi === best.midi && candidate.amplitude > best.amplitude)) best = candidate;
      end++;
    }
    selected.push(best);
    index = end;
  }

  const coalesced: typeof selected = [];
  for (const event of selected) {
    const previous = coalesced.at(-1);
    if (previous && previous.midi === event.midi
      && event.start <= previous.start + previous.duration + .06) {
      previous.duration = Math.max(previous.duration, event.start + event.duration - previous.start);
      previous.amplitude = Math.max(previous.amplitude, event.amplitude);
    } else coalesced.push(event);
  }

  return normalizeMonophonicNotes(coalesced.map(event => ({
    start: Math.max(range.start, event.start),
    duration: Math.min(event.start + event.duration, range.end) - Math.max(range.start, event.start),
    midi: event.midi,
    confidence: .55 + event.amplitude * .45,
    strength: event.amplitude,
  })), range.end);
}

async function createBasicPitchRuntime(): Promise<BasicPitchRuntime> {
  await initializeBasicPitchWasmBackend();
  const [module, tf] = await Promise.all([
    import('@spotify/basic-pitch'),
    import('@tensorflow/tfjs'),
  ]);
  const model = new module.BasicPitch(`${import.meta.env.BASE_URL}models/basic-pitch/model.json`);
  installBasicPitchWasmCompatibility(model, tf);
  return {
    model,
    noteFramesToTime: module.noteFramesToTime,
    outputToNotesPoly: module.outputToNotesPoly,
  };
}

async function disposeBasicPitch(runtime: BasicPitchRuntime): Promise<void> {
  try { (await runtime.model.model).dispose(); } catch { /* A failed model load has nothing to release. */ }
}

async function evaluateBasicPitch(
  runtime: BasicPitchRuntime,
  samples: Float32Array,
  onProgress?: (progress: number) => void,
): Promise<{ frames: number[][]; onsets: number[][]; events: NoteEventTime[] }> {
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  await runtime.model.evaluateModel(samples, (nextFrames, nextOnsets, nextContours) => {
    frames.push(...nextFrames);
    onsets.push(...nextOnsets);
    contours.push(...nextContours);
  }, progress => onProgress?.(clamp(progress, 0, 1)));
  const minimumFrequency = 440 * 2 ** ((MIN_MELODY_MIDI - 69) / 12);
  const maximumFrequency = 440 * 2 ** ((MAX_MELODY_MIDI - 69) / 12);
  const events = runtime.noteFramesToTime(runtime.outputToNotesPoly(
    frames,
    onsets,
    .5,
    .3,
    5,
    true,
    maximumFrequency,
    minimumFrequency,
    false,
  ));
  return { frames, onsets, events };
}

async function transcribeBasicPitchFallback(
  samples: Float32Array,
  onProgress?: (progress: number) => void,
): Promise<MelodyNote[]> {
  const runtime = await createBasicPitchRuntime();
  try {
    const evaluated = await evaluateBasicPitch(runtime, downsampleForBasicPitch(samples), onProgress);
    return decodePredominantMelody(evaluated.frames, evaluated.onsets);
  } finally {
    await disposeBasicPitch(runtime);
  }
}

async function fillInstrumentalGaps(
  samples: Float32Array,
  melody: readonly MelodyNote[],
  onProgress?: (progress: number) => void,
): Promise<MelodyNote[]> {
  const duration = samples.length / MELODY_MODEL_SAMPLE_RATE;
  const gaps = findInstrumentalGaps(melody, duration);
  if (!gaps.length) return [...melody];
  const additions: MelodyNote[] = [];
  const runtime = await createBasicPitchRuntime();
  try {
    for (const [index, gap] of gaps.entries()) {
      const paddedStart = Math.max(0, gap.start - GAP_ANALYSIS_PADDING_SECONDS);
      const paddedEnd = Math.min(duration, gap.end + GAP_ANALYSIS_PADDING_SECONDS);
      const segment = samples.slice(
        Math.floor(paddedStart * MELODY_MODEL_SAMPLE_RATE),
        Math.ceil(paddedEnd * MELODY_MODEL_SAMPLE_RATE),
      );
      const evaluated = await evaluateBasicPitch(
        runtime,
        downsampleForBasicPitch(segment),
        progress => onProgress?.((index + progress) / gaps.length),
      );
      additions.push(...selectInstrumentalLead(evaluated.events, paddedStart, gap));
    }
  } finally {
    await disposeBasicPitch(runtime);
  }
  return normalizeMonophonicNotes([...melody, ...additions], duration);
}

/** Runs inside the melody worker; exported separately for deterministic unit tests. */
export async function transcribeMelodyInWorker(
  samples: Float32Array,
  onProgress?: (progress: number) => void,
): Promise<MelodyNote[]> {
  if (!(samples instanceof Float32Array) || !samples.length) return [];
  let gameMelody: MelodyNote[];
  try {
    gameMelody = await transcribeGameMelody(samples, progress => onProgress?.(progress * .86));
    if (gameMelody.length < 8) return transcribeBasicPitchFallback(samples, onProgress);
  } catch {
    return transcribeBasicPitchFallback(samples, onProgress);
  }
  try {
    return await fillInstrumentalGaps(
      samples,
      gameMelody,
      progress => onProgress?.(.86 + progress * .14),
    );
  } catch (error) {
    console.warn('Basic Pitch 器乐空段补全失败，保留 GAME 歌声转录结果。', error);
    return gameMelody;
  }
}

/** Keep heavyweight model inference off the React/UI thread. */
export async function transcribeMelody(
  samples: Float32Array,
  onProgress?: (progress: number) => void,
): Promise<MelodyNote[]> {
  if (!(samples instanceof Float32Array) || !samples.length) return [];
  return new Promise<MelodyNote[]>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/melody.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const timeout = globalThis.setTimeout(
      () => finish(new Error('逐音模型运行超时，请关闭其他占用内存的页面后重试。')),
      8 * 60_000,
    );
    function finish(error?: Error, melody?: MelodyNote[]) {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error);
      else resolve(melody ?? []);
    }
    worker.onmessage = (event: MessageEvent<MelodyWorkerMessage>) => {
      const message = event.data;
      if (message.type === 'progress') onProgress?.(clamp(message.progress, 0, 1));
      else if (message.type === 'result') finish(undefined, message.melody);
      else finish(new Error(message.message));
    };
    worker.onerror = () => finish(new Error('逐音模型 Worker 运行失败。'));
    worker.onmessageerror = () => finish(new Error('无法读取逐音模型结果。'));
    try {
      worker.postMessage({ samples }, [samples.buffer]);
    } catch {
      finish(new Error('无法把音频传给逐音模型。'));
    }
  });
}
