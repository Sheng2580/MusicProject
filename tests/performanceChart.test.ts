import { describe, expect, it } from 'vitest';
import { createPracticeChart, guitarPositionForMidi, nearestPracticeCue, nearestPracticeCueOnString, normalizeKnownTempo, normalizeMelodyNotes, parseImportedMelody, practiceCuesInFlightWindow } from '../src/lib/performanceChart';
import type { SongAnalysis } from '../src/types';

function analysis(overrides: Partial<SongAnalysis> = {}): SongAnalysis {
  return {
    duration: 8,
    bpm: 80,
    beats: [0, .75, 1.5, 2.25],
    chords: [{ id: 'c', start: 0, end: 8, chord: 'C', confidence: .8 }],
    waveform: [], key: 'C', confidence: .8, algorithm: 'test',
    ...overrides,
  };
}

describe('melody-backed practice chart', () => {
  it('sanitizes imported notes and gives every musical event a stable identity and lane', () => {
    const input = analysis({ melody: [
      { start: 1, duration: .2, midi: 60, confidence: .9, strength: .7 },
      { start: 1.5, duration: .3, midi: 64, confidence: .8, strength: .6 },
      { start: 2, duration: .2, midi: 67, confidence: .85, strength: .8 },
    ] });
    const first = createPracticeChart(input);
    const second = createPracticeChart(input);
    expect(first).toEqual(second);
    expect(first.map(cue => cue.midi)).toEqual([60, 64, 67]);
    expect(first.every(cue => cue.stringIndex >= 0 && cue.stringIndex < 6 && cue.fret >= 0 && cue.fret <= 22)).toBe(true);
  });

  it('finds the closest cue with a signed timing difference', () => {
    const cues = createPracticeChart(analysis({ melody: [
      { start: 1, duration: .2, midi: 60, confidence: 1, strength: 1 },
      { start: 2, duration: .2, midi: 62, confidence: 1, strength: 1 },
    ] }));
    const nearest = nearestPracticeCue(cues, 1.85);
    expect(nearest?.index).toBe(1);
    expect(nearest?.difference).toBeCloseTo(-.15);
    expect(nearestPracticeCue([], 1)).toBeNull();
  });

  it('skips already played cues when dense attacks share one timing window', () => {
    const cues = createPracticeChart(analysis({ melody: [
      { start: 1, duration: .2, midi: 60, confidence: 1, strength: 1 },
      { start: 1.08, duration: .2, midi: 62, confidence: 1, strength: 1 },
    ] }));

    expect(nearestPracticeCue(cues, 1.03)?.cue.id).toBe(cues[0].id);
    expect(nearestPracticeCue(cues, 1.03, new Set([cues[0].id]))?.cue.id).toBe(cues[1].id);
    expect(nearestPracticeCue(cues, 1.03, new Set(cues.map(cue => cue.id)))).toBeNull();
  });

  it('finds the nearest audible cue on the string the player actually touched', () => {
    const cues = createPracticeChart(analysis({ melody: [
      { start: 1, duration: .2, midi: 60, confidence: 1, strength: 1 },
      { start: 1.2, duration: .2, midi: 72, confidence: 1, strength: 1 },
    ] }));
    const lane = cues[0].stringIndex;

    expect(nearestPracticeCueOnString(cues, 1.15, lane)?.cue.id).toBe(cues[0].id);
    expect(nearestPracticeCueOnString(cues, 2, lane)).toBeNull();
    expect(nearestPracticeCueOnString(cues, 1, -1)).toBeNull();
  });

  it('matches an unplayed dense cue on the touched string before a closer cue on another string', () => {
    const cues = createPracticeChart(analysis({ melody: [
      { start: 1, duration: .2, midi: 60, confidence: 1, strength: 1 },
      { start: 1.08, duration: .2, midi: 72, confidence: 1, strength: 1 },
      { start: 1.14, duration: .2, midi: 74, confidence: 1, strength: 1 },
    ] }));
    expect(cues[0].stringIndex).not.toBe(cues[1].stringIndex);
    expect(nearestPracticeCueOnString(cues, 1.03, cues[1].stringIndex, .18)?.cue.id).toBe(cues[1].id);
    expect(nearestPracticeCueOnString(
      cues,
      1.1,
      cues[1].stringIndex,
      .18,
      new Set([cues[1].id]),
    )?.cue.id).toBe(cues[2].id);
  });

  it('removes a consumed cue immediately without hiding neighboring chart attacks', () => {
    const cues = createPracticeChart(analysis({ melody: [
      { start: .8, duration: .2, midi: 60, confidence: 1, strength: 1 },
      { start: 1, duration: .2, midi: 62, confidence: 1, strength: 1 },
      { start: 1.2, duration: .2, midi: 64, confidence: 1, strength: 1 },
    ] }));
    const consumed = new Set([cues[1].id]);

    expect(practiceCuesInFlightWindow(cues, .9, consumed).map(cue => cue.id)).toEqual([
      cues[0].id,
      cues[2].id,
    ]);
    expect(practiceCuesInFlightWindow(cues, .9, new Set()).map(cue => cue.id)).toEqual(
      cues.map(cue => cue.id),
    );
    expect(cues).toHaveLength(3);
  });

  it('normalizes malformed external melody data without mutating valid ordering', () => {
    expect(normalizeMelodyNotes([
      { start: 2, duration: 10, midi: 64.4, confidence: 2, strength: -1 },
      { start: Number.NaN, duration: 1, midi: 60, confidence: 1, strength: 1 },
      { start: 1, duration: .01, midi: 60, confidence: .7, strength: .8 },
    ], 4)).toEqual([
      { start: 1, duration: .045, midi: 60, confidence: .7, strength: .8 },
      { start: 2, duration: 2, midi: 64, confidence: 1, strength: 0 },
    ]);
  });

  it('accepts a complete score-tool melody and rejects payloads that would lose attacks', () => {
    const valid = Array.from({ length: 8 }, (_, index) => ({
      start: index * .5,
      duration: .2,
      midi: 60 + index,
      confidence: .9,
      strength: .8,
    }));
    expect(parseImportedMelody(valid, 8)).toHaveLength(8);
    expect(() => parseImportedMelody([...valid, { ...valid[0], start: Number.NaN }], 8)).toThrow(/无效/);
    expect(() => parseImportedMelody(valid.slice(0, 7), 8)).toThrow(/音符过少/);
  });

  it('corrects a double-tempo beat alias for a demo with known BPM', () => {
    const source = analysis({ bpm: 160, beats: [0, .375, .75, 1.125, 1.5] });
    const corrected = normalizeKnownTempo(source, 80);
    expect(corrected.bpm).toBe(80);
    expect(corrected.beats).toEqual([0, .75, 1.5]);
    expect(corrected.algorithm).toContain('已校准 80 BPM');
    expect(source.bpm).toBe(160);
  });

  it('keeps beat positions when the detected tempo is already near the known BPM', () => {
    const source = analysis({ bpm: 79, beats: [.1, .85, 1.6] });
    expect(normalizeKnownTempo(source, 80).beats).toEqual(source.beats);
    expect(normalizeKnownTempo(source, Number.NaN)).toBe(source);
  });

  it('maps common melody pitches to real standard-tuning positions', () => {
    const middle = guitarPositionForMidi(64);
    expect(40 + [0, 5, 10, 15, 19, 24][middle.stringIndex] + middle.fret).toBe(64);
    const high = guitarPositionForMidi(72);
    expect(40 + [0, 5, 10, 15, 19, 24][high.stringIndex] + high.fret).toBe(72);
    expect(guitarPositionForMidi(86)).toEqual({ stringIndex: 5, fret: 22 });
  });

  it('uses natural low-fret positions instead of pinning a melody to one string', () => {
    const g = guitarPositionForMidi(58);
    const b = guitarPositionForMidi(60, g);
    const e = guitarPositionForMidi(65, b);
    expect(g).toEqual({ stringIndex: 3, fret: 3 });
    expect(b).toEqual({ stringIndex: 4, fret: 1 });
    expect(e).toEqual({ stringIndex: 5, fret: 1 });
  });

  it('never invents a chord-tone melody when an analysis has no transcribed notes', () => {
    const chart = createPracticeChart(analysis({ melody: undefined }));
    expect(chart).toEqual([]);
  });
});
