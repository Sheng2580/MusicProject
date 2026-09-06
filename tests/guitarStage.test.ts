import { describe, expect, it, vi } from 'vitest';
import { dispatchPracticeSweepStrings, findPracticeSweepTarget } from '../src/GuitarStage';
import type { PracticeCue, PracticeHit } from '../src/types';

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

const practice = (
  cues: PracticeCue[],
  time: number,
  hits: PracticeHit[] = [],
  judgedCueIds = new Set(hits.map(hit => hit.cueId)),
) => ({
  cues,
  getTime: () => time,
  isPlaying: () => true,
  getJudgedCueIds: () => judgedCueIds,
  hits,
  revision: 0,
});

describe('practice mouse sweeps', () => {
  it('animates every crossing but makes only the current practice target audible', () => {
    const dispatch = vi.fn((_stringIndex: number, _audible: boolean) => true);
    const matched = dispatchPracticeSweepStrings(
      [0, 1, 2, 3, 4, 5],
      { cueId: 'target', stringIndex: 2 },
      null,
      dispatch,
    );

    expect(dispatch.mock.calls).toEqual([
      [0, false],
      [1, false],
      [2, true],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(matched).toBe('target');
  });

  it('dispatches every crossed string when there is no active practice target', () => {
    const dispatch = vi.fn((_stringIndex: number, _audible: boolean) => true);
    expect(dispatchPracticeSweepStrings([5, 4, 3, 2, 1, 0], null, null, dispatch)).toBeNull();
    expect(dispatch.mock.calls).toEqual([[5, true], [4, true], [3, true], [2, true], [1, true], [0, true]]);
  });

  it('does not mark a throttled target pluck as a hit', () => {
    const dispatch = vi.fn((stringIndex: number, _audible: boolean) => stringIndex !== 2);
    const matched = dispatchPracticeSweepStrings(
      [1, 2, 3],
      { cueId: 'target', stringIndex: 2 },
      null,
      dispatch,
    );

    expect(matched).toBeNull();
    expect(dispatch.mock.calls).toEqual([[1, false], [2, true], [3, false]]);
  });

  it('selects the nearest unhit cue only while it is playable now', () => {
    const played = cue('played', 1, 1);
    const next = cue('next', 1.08, 3);
    const hit: PracticeHit = { cueId: played.id, at: 100, perfect: true };

    expect(findPracticeSweepTarget(practice([played, next], 1.02, [hit]))).toEqual({
      cueId: next.id,
      stringIndex: next.stringIndex,
    });
    expect(findPracticeSweepTarget(practice([played, next], 1.4))).toBeNull();
    expect(findPracticeSweepTarget({ ...practice([played], 1), isPlaying: () => false })).toBeNull();
  });

  it('reads hit and miss exclusions synchronously instead of waiting for rendered hit props', () => {
    const played = cue('played', 1, 1);
    const next = cue('next', 1.08, 3);
    const judgedCueIds = new Set<string>();
    const state = practice([played, next], 1.02, [], judgedCueIds);

    expect(findPracticeSweepTarget(state)?.cueId).toBe(played.id);
    judgedCueIds.add(played.id);
    expect(findPracticeSweepTarget(state)?.cueId).toBe(next.id);
    judgedCueIds.add(next.id);
    expect(findPracticeSweepTarget(state)).toBeNull();
  });

  it('allows a fresh gesture to dispatch the target after the prior gesture matched it', () => {
    const target = { cueId: 'target', stringIndex: 4 };
    const dispatch = vi.fn((_stringIndex: number, _audible: boolean) => true);

    expect(dispatchPracticeSweepStrings([4, 5], target, 'target', dispatch)).toBe('target');
    expect(dispatch.mock.calls).toEqual([[4, false], [5, false]]);

    dispatch.mockClear();
    expect(dispatchPracticeSweepStrings([4, 5], target, null, dispatch)).toBe('target');
    expect(dispatch.mock.calls).toEqual([[4, true], [5, false]]);
  });
});
