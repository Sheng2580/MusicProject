import { describe, expect, it } from 'vitest';
import { chordAt, formatTime, isHighMatch, nearestBeat, replaceChordBoundary, timingGrade, validateBoundaries } from '../src/lib/game';
import type { ChordSegment, PlayMode } from '../src/types';

function chords(): ChordSegment[] {
  return [
    { id: 'c', start: 0, end: 1, chord: 'C', confidence: 0.9 },
    { id: 'am', start: 1, end: 2, chord: 'Am', confidence: 0.8 },
    { id: 'f', start: 2, end: 3, chord: 'F', confidence: 0.7 },
    { id: 'g', start: 3, end: 4, chord: 'G', confidence: 0.9 },
  ];
}

describe('time display', () => {
  it.each([
    [0, '0:00'],
    [9.9, '0:09'],
    [59.999, '0:59'],
    [60, '1:00'],
    [229.564082, '3:49'],
    [214.248, '3:34'],
  ] as const)('formats %s seconds as %s without rounding up', (seconds, expected) => {
    expect(formatTime(seconds)).toBe(expected);
  });

  it.each([-1, NaN, Infinity, -Infinity])('uses zero for an invalid duration (%s)', value => {
    expect(formatTime(value)).toBe('0:00');
  });
});

describe('rhythm judgment and reward', () => {
  it.each(['easy', 'challenge'] as PlayMode[])('unlocks high match at the exact threshold during %s play', mode => {
    expect(isHighMatch(6, 85, true, mode)).toBe(true);
    expect(isHighMatch(20, 100, true, mode)).toBe(true);
    expect(isHighMatch(5, 100, true, mode)).toBe(false);
    expect(isHighMatch(6, 84.999, true, mode)).toBe(false);
  });

  it('does not reward paused sessions, free play, or an empty score', () => {
    expect(isHighMatch(12, 100, false, 'easy')).toBe(false);
    expect(isHighMatch(12, 100, true, 'free')).toBe(false);
    expect(isHighMatch(0, 0, true, 'challenge')).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite high-match scores (%s)', value => {
    expect(isHighMatch(value, 100, true, 'easy')).toBe(false);
    expect(isHighMatch(10, value, true, 'easy')).toBe(false);
  });

  it.each([
    [0, 'perfect'],
    [0.08, 'perfect'],
    [-0.08, 'perfect'],
    [0.080001, 'good'],
    [-0.080001, 'good'],
    [0.18, 'good'],
    [-0.18, 'good'],
    [0.180001, 'miss'],
    [-0.180001, 'miss'],
    [2, 'miss'],
    [-2, 'miss'],
    [NaN, 'miss'],
    [Infinity, 'miss'],
    [-Infinity, 'miss'],
  ] as const)('grades signed timing difference %s as %s', (difference, grade) => {
    expect(timingGrade(difference)).toBe(grade);
  });
});

describe('beat lookup', () => {
  it('returns no beat for an empty beat grid', () => {
    expect(nearestBeat([], 1)).toBeNull();
  });

  it('finds exact beats and retains the signed early/late offset', () => {
    const beats = [0.5, 1, 1.5, 2];
    expect(nearestBeat(beats, 1)).toEqual({ index: 1, difference: 0 });
    expect(nearestBeat(beats, 0.875)).toEqual({ index: 1, difference: -0.125 });
    expect(nearestBeat(beats, 1.125)).toEqual({ index: 1, difference: 0.125 });
  });

  it('uses the closest edge beat outside the grid and handles one beat', () => {
    expect(nearestBeat([0.5, 1, 1.5], 0)).toEqual({ index: 0, difference: -0.5 });
    expect(nearestBeat([0.5, 1, 1.5], 2)).toEqual({ index: 2, difference: 0.5 });
    expect(nearestBeat([1], 1.25)).toEqual({ index: 0, difference: 0.25 });
  });

  it('chooses the later beat when two distances are identical', () => {
    expect(nearestBeat([1, 2], 1.5)).toEqual({ index: 1, difference: -0.5 });
  });
});

describe('chord selection and correction', () => {
  it('uses start-inclusive and end-exclusive chord intervals', () => {
    const sequence = chords();
    expect(chordAt(sequence, 0)).toBe(sequence[0]);
    expect(chordAt(sequence, 0.999)).toBe(sequence[0]);
    expect(chordAt(sequence, 1)).toBe(sequence[1]);
    expect(chordAt(sequence, 3.999)).toBe(sequence[3]);
    expect(chordAt(sequence, 4)).toBeUndefined();
    expect(chordAt(sequence, -1)).toBeUndefined();
    expect(chordAt([], 0)).toBeUndefined();
  });

  it('preselects the first chord at zero but leaves later gaps unassigned', () => {
    const sequence = [{ ...chords()[0], start: 0.5, end: 1 }];
    expect(chordAt(sequence, 0)).toBe(sequence[0]);
    expect(chordAt(sequence, 0.25)).toBeUndefined();
    expect(chordAt(sequence, 1.5)).toBeUndefined();
  });

  it('validates finite, ordered boundaries within the track', () => {
    const chord = chords()[1];
    expect(validateBoundaries(chord, 0.5, 1.5, 4)).toBe(true);
    expect(validateBoundaries(chord, -0.1, 1, 4)).toBe(false);
    expect(validateBoundaries(chord, 1, 4.1, 4)).toBe(false);
    expect(validateBoundaries(chord, 1.1, 1, 4)).toBe(false);
    expect(validateBoundaries(chord, 1, 1.05, 4)).toBe(false);
    expect(validateBoundaries(chord, NaN, 1, 4)).toBe(false);
    expect(validateBoundaries(chord, 1, Infinity, 4)).toBe(false);
    expect(validateBoundaries({ ...chord, id: '' }, 1, 2, 4)).toBe(false);
  });

  it('moves adjoining boundaries with an edit without mutating source segments', () => {
    const sequence = chords();
    const original = structuredClone(sequence);
    const result = replaceChordBoundary(sequence, 1, 0.75, 2.25);
    expect(result[0]).toEqual({ ...sequence[0], end: 0.75, edited: true });
    expect(result[1]).toEqual({ ...sequence[1], start: 0.75, end: 2.25, edited: true });
    expect(result[2]).toEqual({ ...sequence[2], start: 2.25, edited: true });
    expect(result[3]).toBe(sequence[3]);
    expect(sequence).toEqual(original);
  });

  it('can correct the first and last chord without a nonexistent neighbor', () => {
    const sequence = chords();
    const first = replaceChordBoundary(sequence, 0, 0, 1.25);
    expect(first[0].end).toBe(1.25);
    expect(first[1].start).toBe(1.25);
    expect(first[2]).toBe(sequence[2]);
    const last = replaceChordBoundary(sequence, 3, 2.75, 4);
    expect(last[2].end).toBe(2.75);
    expect(last[3].start).toBe(2.75);
    expect(last[0]).toBe(sequence[0]);
  });
});
