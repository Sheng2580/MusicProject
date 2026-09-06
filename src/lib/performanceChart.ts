import type { MelodyNote, PracticeCue, SongAnalysis } from '../types';

const OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64] as const;
const MAX_FRET = 22;
export const PRACTICE_FLIGHT_SECONDS = 2.2;
export const PRACTICE_MISS_FADE_SECONDS = .4;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function normalizeMelodyNotes(value: unknown, trackDuration: number): MelodyNote[] {
  if (!Array.isArray(value) || !Number.isFinite(trackDuration) || trackDuration <= 0) return [];
  const notes = value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Partial<Record<keyof MelodyNote, unknown>>;
    const start = Number(row.start);
    const duration = Number(row.duration);
    const midi = Number(row.midi);
    const confidence = Number(row.confidence);
    const strength = Number(row.strength);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || !Number.isFinite(midi)
      || start < 0 || start >= trackDuration || duration <= 0 || midi < 24 || midi > 108) return [];
    return [{
      start,
      duration: clamp(duration, .045, Math.min(6, trackDuration - start)),
      midi: Math.round(midi),
      confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : .5,
      strength: Number.isFinite(strength) ? clamp(strength, 0, 1) : .5,
    }];
  }).sort((a, b) => a.start - b.start || b.confidence - a.confidence || a.midi - b.midi);

  return notes.filter((note, index) => !notes.slice(Math.max(0, index - 2), index).some(previous => (
    Math.abs(previous.start - note.start) < .018 && previous.midi === note.midi
  )));
}

/** Validate a score-tool melody payload without silently dropping malformed attacks. */
export function parseImportedMelody(value: unknown, trackDuration: number): MelodyNote[] {
  if (!Array.isArray(value) || value.length > 20000) throw new Error('旋律谱必须是逐音 JSON 数组');
  const melody = normalizeMelodyNotes(value, trackDuration);
  if (melody.length !== value.length) throw new Error('旋律谱包含无效、重复或超出音频范围的音符');
  if (melody.length < 8) throw new Error('旋律谱音符过少，请确认选择了完整主旋律声部');
  return melody;
}

/** Correct a known song whose onset tracker selected a half-beat tempo alias. */
export function normalizeKnownTempo(analysis: SongAnalysis, targetBpm: number): SongAnalysis {
  if (!Number.isFinite(targetBpm) || targetBpm < 20 || targetBpm > 300) return analysis;
  const ratio = analysis.bpm / targetBpm;
  const beats = ratio >= 1.7 && ratio <= 2.3
    ? analysis.beats.filter((_, index) => index % 2 === 0)
    : analysis.beats;
  const marker = `已校准 ${Math.round(targetBpm)} BPM`;
  return {
    ...analysis,
    bpm: targetBpm,
    beats,
    algorithm: analysis.algorithm.includes(marker) ? analysis.algorithm : `${analysis.algorithm} / ${marker}`,
  };
}

function playableMidi(midi: number): number {
  let result = midi;
  while (result < OPEN_STRING_MIDI[0]) result += 12;
  while (result > OPEN_STRING_MIDI[5] + MAX_FRET) result -= 12;
  return result;
}

export function guitarPositionForMidi(
  midi: number,
  previous?: Pick<PracticeCue, 'stringIndex' | 'fret'>,
): { stringIndex: number; fret: number } {
  const target = playableMidi(Math.round(midi));
  const candidates = OPEN_STRING_MIDI.flatMap((open, stringIndex) => {
    const fret = target - open;
    if (fret < 0 || fret > MAX_FRET) return [];
    // Prefer the lowest practical fret. The previous weights made staying on
    // one string much cheaper than a natural adjacent-string move, so an
    // entire vocal line often collapsed into one repetitive lane.
    const positionCost = fret * .13 + (fret > 12 ? (fret - 12) * .2 : 0);
    const movementCost = previous
      ? Math.abs(previous.stringIndex - stringIndex) * .16 + Math.abs(previous.fret - fret) * .025
      : 0;
    return [{ stringIndex, fret, score: positionCost + movementCost }];
  });
  candidates.sort((a, b) => a.score - b.score || b.stringIndex - a.stringIndex);
  const best = candidates[0];
  return best ? { stringIndex: best.stringIndex, fret: best.fret } : { stringIndex: 0, fret: 0 };
}

export function createPracticeChart(analysis: SongAnalysis): PracticeCue[] {
  const source = normalizeMelodyNotes(analysis.melody, analysis.duration);
  let previous: Pick<PracticeCue, 'stringIndex' | 'fret'> | undefined;
  return source.map((note, sourceIndex) => {
    const midi = playableMidi(note.midi);
    const position = guitarPositionForMidi(midi, previous);
    previous = position;
    return {
      id: `note-${sourceIndex}-${Math.round(note.start * 1000)}-${midi}`,
      time: note.start,
      duration: note.duration,
      midi,
      stringIndex: position.stringIndex,
      fret: position.fret,
      confidence: note.confidence,
      strength: note.strength,
      sourceIndex,
    };
  });
}

/** Return the unconsumed notes that belong on the falling-note track now. */
export function practiceCuesInFlightWindow(
  cues: readonly PracticeCue[],
  trackTime: number,
  consumedCueIds: ReadonlySet<string>,
  flightSeconds = PRACTICE_FLIGHT_SECONDS,
  missFadeSeconds = PRACTICE_MISS_FADE_SECONDS,
): PracticeCue[] {
  if (!Number.isFinite(trackTime) || !Number.isFinite(flightSeconds) || flightSeconds < 0
    || !Number.isFinite(missFadeSeconds) || missFadeSeconds < 0) return [];
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].time < trackTime - missFadeSeconds) low = middle + 1;
    else high = middle;
  }
  const visible: PracticeCue[] = [];
  for (let index = low; index < cues.length; index++) {
    const cue = cues[index];
    if (cue.time - trackTime > flightSeconds) break;
    if (consumedCueIds.has(cue.id) || !Number.isFinite(cue.time)
      || !Number.isInteger(cue.stringIndex) || cue.stringIndex < 0 || cue.stringIndex > 5) continue;
    visible.push(cue);
  }
  return visible;
}

export function nearestPracticeCue(
  cues: PracticeCue[],
  time: number,
  excludedCueIds?: ReadonlySet<string>,
): { cue: PracticeCue; index: number; difference: number } | null {
  if (!cues.length || !Number.isFinite(time)) return null;
  if (excludedCueIds?.size) {
    let best: { cue: PracticeCue; index: number; difference: number } | null = null;
    for (let index = 0; index < cues.length; index++) {
      const cue = cues[index];
      if (excludedCueIds.has(cue.id)) continue;
      const difference = time - cue.time;
      if (!best || Math.abs(difference) < Math.abs(best.difference)) best = { cue, index, difference };
      if (cue.time > time && best && cue.time - time > Math.abs(best.difference)) break;
    }
    return best;
  }
  let low = 0;
  let high = cues.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].time < time) low = middle + 1;
    else high = middle;
  }
  const index = low > 0 && Math.abs(cues[low - 1].time - time) < Math.abs(cues[low].time - time) ? low - 1 : low;
  return { cue: cues[index], index, difference: time - cues[index].time };
}

export function nearestPracticeCueOnString(
  cues: PracticeCue[],
  time: number,
  stringIndex: number,
  maximumDistance = .45,
  excludedCueIds?: ReadonlySet<string>,
): { cue: PracticeCue; index: number; difference: number } | null {
  if (!Number.isFinite(time) || !Number.isInteger(stringIndex) || stringIndex < 0 || stringIndex > 5
    || !Number.isFinite(maximumDistance) || maximumDistance < 0) return null;
  let best: { cue: PracticeCue; index: number; difference: number } | null = null;
  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index];
    const difference = time - cue.time;
    if (difference < -maximumDistance) break;
    if (cue.stringIndex !== stringIndex || excludedCueIds?.has(cue.id)
      || Math.abs(difference) > maximumDistance) continue;
    if (!best || Math.abs(difference) < Math.abs(best.difference)) best = { cue, index, difference };
  }
  return best;
}
