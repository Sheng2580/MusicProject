import { describe, expect, it } from 'vitest';
import { currentPracticeCue, isPracticeClockPlaying, practiceChordMatches, practiceClockTime, resolveKeyboardStrum, resolvePracticeSound } from '../src/lib/practiceSession';
import type { PracticeLeadIn } from '../src/lib/practiceSession';
import type { PracticeCue } from '../src/types';

const leadIn = (phase: PracticeLeadIn['phase']): PracticeLeadIn => ({
  phase,
  startedAt: 5_000,
  from: -2.2,
  target: 0,
});

const cue = (id: string, time: number, stringIndex: number): PracticeCue => ({
  id,
  time,
  duration: .2,
  midi: 60 + stringIndex,
  stringIndex,
  fret: 1,
  confidence: 1,
  strength: 1,
  sourceIndex: stringIndex,
});

describe('practice session timing', () => {
  it('holds the practice clock still during the unmarked wait', () => {
    expect(practiceClockTime(4, leadIn('waiting'), 99_000)).toBe(-2.2);
    expect(isPracticeClockPlaying(false, leadIn('waiting'))).toBe(false);
  });

  it('uses the falling-note clock as a playable timeline before audio starts', () => {
    const falling = leadIn('falling');
    expect(practiceClockTime(0, falling, 5_000)).toBe(-2.2);
    expect(practiceClockTime(0, falling, 7_020)).toBeCloseTo(-.18);
    expect(practiceClockTime(0, falling, 8_000)).toBe(0);
    expect(isPracticeClockPlaying(false, falling)).toBe(true);
  });

  it('uses the audio engine clock once playback has begun', () => {
    expect(practiceClockTime(12.4, null, 30_000)).toBe(12.4);
    expect(isPracticeClockPlaying(true, null)).toBe(true);
    expect(isPracticeClockPlaying(false, null)).toBe(false);
  });
});

describe('challenge chord retry', () => {
  it('rejects only a real challenge chord mismatch', () => {
    expect(practiceChordMatches('challenge', 'G', 'C')).toBe(false);
    expect(practiceChordMatches('challenge', 'G', 'G')).toBe(true);
    expect(practiceChordMatches('challenge', 'N', 'C')).toBe(true);
    expect(practiceChordMatches('challenge', undefined, 'C')).toBe(true);
    expect(practiceChordMatches('easy', 'G', 'C')).toBe(true);
  });
});

describe('practice gesture sound routing', () => {
  it('silences misses during an active take but preserves free and paused playing', () => {
    expect(resolvePracticeSound('easy', true, null)).toEqual({ kind: 'silent' });
    expect(resolvePracticeSound('challenge', true, null)).toEqual({ kind: 'silent' });
    expect(resolvePracticeSound('free', true, null)).toEqual({ kind: 'instrument' });
    expect(resolvePracticeSound('easy', false, null)).toEqual({ kind: 'instrument' });
  });

  it('routes an active hit to exactly that melody cue', () => {
    const target = cue('target', 1, 2);
    expect(resolvePracticeSound('easy', true, target)).toEqual({ kind: 'cue', cue: target });
  });

  it('selects one unjudged cue for a keyboard sweep only inside the hit window', () => {
    const played = cue('played', 1, 1);
    const next = cue('next', 1.08, 4);
    expect(currentPracticeCue([played, next], 1.02, new Set([played.id]))).toBe(next);
    expect(currentPracticeCue([played, next], 1.4, new Set())).toBeNull();
    expect(currentPracticeCue([played, next], 1, new Set(), -1)).toBeNull();
  });

  it('animates only the selected cue for J/K during a take and never fakes a full sweep on a miss', () => {
    const played = cue('played', 1, 1);
    const next = cue('next', 1.08, 4);
    expect(resolveKeyboardStrum('easy', true, [played, next], 1.02, new Set([played.id])))
      .toEqual({ kind: 'cue', cue: next });
    expect(resolveKeyboardStrum('challenge', true, [played, next], 1.4, new Set()))
      .toEqual({ kind: 'silent' });
    expect(resolveKeyboardStrum('free', true, [played, next], 1.02, new Set()))
      .toEqual({ kind: 'instrument' });
    expect(resolveKeyboardStrum('easy', false, [played, next], 1.02, new Set()))
      .toEqual({ kind: 'instrument' });
  });
});
