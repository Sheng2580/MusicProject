import type { PlayMode, PracticeCue } from '../types';
import { nearestPracticeCue } from './performanceChart';

export interface PracticeLeadIn {
  phase: 'waiting' | 'falling';
  startedAt: number;
  from: number;
  target: number;
}

export function practiceClockTime(
  engineTime: number,
  leadIn: PracticeLeadIn | null,
  now: number,
): number {
  if (!leadIn) return engineTime;
  if (leadIn.phase === 'waiting') return leadIn.from;
  const elapsed = Math.max(0, now - leadIn.startedAt) / 1000;
  return Math.min(leadIn.target, leadIn.from + elapsed);
}

export function isPracticeClockPlaying(
  enginePlaying: boolean,
  leadIn: PracticeLeadIn | null,
): boolean {
  return enginePlaying || leadIn?.phase === 'falling';
}

export function practiceChordMatches(
  mode: PlayMode,
  targetChord: string | undefined,
  selectedChord: string,
): boolean {
  return mode !== 'challenge'
    || !targetChord
    || targetChord === 'N'
    || targetChord === selectedChord;
}

export type PracticeSoundDecision =
  | { kind: 'cue'; cue: PracticeCue }
  | { kind: 'instrument' }
  | { kind: 'silent' };

/** Keep ordinary guitar playing available unless an active melody take owns the gesture. */
export function resolvePracticeSound(
  mode: PlayMode,
  practicePlaying: boolean,
  matchedCue: PracticeCue | null,
): PracticeSoundDecision {
  if (mode === 'free' || !practicePlaying) return { kind: 'instrument' };
  return matchedCue ? { kind: 'cue', cue: matchedCue } : { kind: 'silent' };
}

/** Select at most one currently playable cue for a keyboard sweep. */
export function currentPracticeCue(
  cues: PracticeCue[],
  time: number,
  judgedCueIds: ReadonlySet<string>,
  maximumDistance = .18,
): PracticeCue | null {
  if (!Number.isFinite(maximumDistance) || maximumDistance < 0) return null;
  const nearest = nearestPracticeCue(cues, time, judgedCueIds);
  return nearest && Math.abs(nearest.difference) <= maximumDistance ? nearest.cue : null;
}

/** Route a keyboard sweep to one cue during practice, or to the instrument outside a take. */
export function resolveKeyboardStrum(
  mode: PlayMode,
  practicePlaying: boolean,
  cues: PracticeCue[],
  time: number,
  judgedCueIds: ReadonlySet<string>,
  maximumDistance = .18,
): PracticeSoundDecision {
  const cue = mode !== 'free' && practicePlaying
    ? currentPracticeCue(cues, time, judgedCueIds, maximumDistance)
    : null;
  return resolvePracticeSound(mode, practicePlaying, cue);
}
