import { describe, expect, it } from 'vitest';
import {
  decodePredominantMelody,
  findInstrumentalGaps,
  selectInstrumentalLead,
} from '../src/lib/melodyTranscription';
import { normalizeMonophonicNotes } from '../src/lib/gameTranscription';

const PITCHES = 88;
const MIDI_OFFSET = 21;

function matrices(length: number) {
  return {
    frames: Array.from({ length }, () => Array(PITCHES).fill(0)),
    onsets: Array.from({ length }, () => Array(PITCHES).fill(0)),
  };
}

function activate(matrix: number[][], midi: number, start: number, end: number, value: number) {
  for (let frame = start; frame < end; frame++) matrix[frame][midi - MIDI_OFFSET] = value;
}

describe('predominant melody decoding', () => {
  it.each([40, 96])('keeps MIDI %i at the configured transcription boundary', midi => {
    const { frames, onsets } = matrices(28);
    activate(frames, midi, 4, 24, .94);
    onsets[4][midi - MIDI_OFFSET] = .9;

    expect(decodePredominantMelody(frames, onsets).map(note => note.midi)).toEqual([midi]);
  });

  it('does not decode the silence state above MIDI 96 as a note', () => {
    const { frames, onsets } = matrices(40);
    activate(frames, 96, 8, 24, .94);
    onsets[8][96 - MIDI_OFFSET] = .9;

    const melody = decodePredominantMelody(frames, onsets);
    expect(melody.map(note => note.midi)).toEqual([96]);
    expect(melody[0].start).toBeGreaterThan(0);
    expect(melody[0].start + melody[0].duration).toBeLessThan(40 * 256 / 22_050);
  });

  it('keeps low male-register notes within the model range', () => {
    const { frames, onsets } = matrices(58);
    activate(frames, 43, 4, 18, .92);
    activate(frames, 45, 21, 35, .92);
    activate(frames, 47, 38, 52, .92);
    onsets[4][43 - MIDI_OFFSET] = .8;
    onsets[21][45 - MIDI_OFFSET] = .8;
    onsets[38][47 - MIDI_OFFSET] = .8;

    expect(decodePredominantMelody(frames, onsets).map(note => note.midi)).toEqual([43, 45, 47]);
  });

  it('keeps the continuous lead above a stronger bass accompaniment', () => {
    const { frames, onsets } = matrices(52);
    activate(frames, 48, 0, 52, .72);
    activate(frames, 64, 0, 26, .65);
    activate(frames, 67, 26, 52, .66);
    onsets[0][64 - MIDI_OFFSET] = .9;
    onsets[26][67 - MIDI_OFFSET] = .9;
    const melody = decodePredominantMelody(frames, onsets);
    expect(melody.map(note => note.midi)).toEqual([64, 67]);
  });

  it('keeps a distant upper lead over a louder bass entrance', () => {
    const { frames, onsets } = matrices(40);
    activate(frames, 50, 0, 40, .75);
    activate(frames, 78, 0, 20, .6);
    activate(frames, 76, 20, 40, .62);
    onsets[0][50 - MIDI_OFFSET] = .92;
    onsets[0][78 - MIDI_OFFSET] = .86;
    onsets[20][76 - MIDI_OFFSET] = .88;
    const melody = decodePredominantMelody(frames, onsets);
    expect(melody.map(note => note.midi)).toEqual([78, 76]);
  });

  it('removes a weak sub-attack pitch flicker', () => {
    const { frames, onsets } = matrices(32);
    activate(frames, 64, 0, 32, .66);
    activate(frames, 67, 12, 18, .85);
    onsets[0][64 - MIDI_OFFSET] = .9;
    const melody = decodePredominantMelody(frames, onsets);
    expect(melody.map(note => note.midi)).toEqual([64]);
  });

  it('preserves a strongly attacked short note', () => {
    const { frames, onsets } = matrices(31);
    activate(frames, 64, 0, 12, .7);
    activate(frames, 67, 12, 19, .72);
    activate(frames, 69, 19, 31, .69);
    onsets[0][64 - MIDI_OFFSET] = .9;
    onsets[12][67 - MIDI_OFFSET] = .91;
    onsets[19][69 - MIDI_OFFSET] = .89;
    const melody = decodePredominantMelody(frames, onsets);
    expect(melody.map(note => note.midi)).toEqual([64, 67, 69]);
    expect(melody[1].duration).toBeGreaterThanOrEqual(.07);
    expect(melody[1].duration).toBeLessThan(.1);
  });

  it('keeps a three-frame strong note when it replaces the previous voice', () => {
    const { frames, onsets } = matrices(35);
    activate(frames, 64, 0, 16, .75);
    activate(frames, 67, 16, 19, .95);
    activate(frames, 69, 19, 35, .75);
    onsets[0][64 - MIDI_OFFSET] = .9;
    onsets[16][67 - MIDI_OFFSET] = .9;
    onsets[19][69 - MIDI_OFFSET] = .9;

    const melody = decodePredominantMelody(frames, onsets);
    expect(melody.map(note => note.midi)).toEqual([64, 67, 69]);
    expect(melody[1].duration).toBe(.045);
  });

  it('rejects a three-frame upper flicker while the previous voice remains active', () => {
    const { frames, onsets } = matrices(35);
    activate(frames, 64, 0, 35, .75);
    activate(frames, 67, 16, 19, .95);
    onsets[0][64 - MIDI_OFFSET] = .9;
    onsets[16][67 - MIDI_OFFSET] = .9;

    expect(decodePredominantMelody(frames, onsets).map(note => note.midi)).toEqual([64]);
  });

  it('preserves separately articulated attacks on one repeated pitch', () => {
    const { frames, onsets } = matrices(27);
    activate(frames, 62, 0, 27, .72);
    onsets[0][62 - MIDI_OFFSET] = .88;
    onsets[9][62 - MIDI_OFFSET] = .81;
    onsets[18][62 - MIDI_OFFSET] = .86;
    const melody = decodePredominantMelody(frames, onsets);
    expect(melody.map(note => note.midi)).toEqual([62, 62, 62]);
    expect(melody.map(note => note.start)).toEqual([...melody.map(note => note.start)].sort((a, b) => a - b));
  });

  it('keeps a strong same-pitch reattack after six frames', () => {
    const { frames, onsets } = matrices(24);
    activate(frames, 62, 0, 24, .72);
    onsets[0][62 - MIDI_OFFSET] = .88;
    onsets[6][62 - MIDI_OFFSET] = .81;

    expect(decodePredominantMelody(frames, onsets).map(note => note.midi)).toEqual([62, 62]);
  });

  it('keeps a weak same-pitch reattack only after an activity valley', () => {
    const { frames, onsets } = matrices(36);
    activate(frames, 64, 4, 32, .92);
    activate(frames, 64, 14, 16, .12);
    onsets[4][64 - MIDI_OFFSET] = .8;
    onsets[16][64 - MIDI_OFFSET] = .57;

    expect(decodePredominantMelody(frames, onsets).map(note => note.midi)).toEqual([64, 64]);
  });

  it('does not split one sustained pitch on a nearby secondary onset peak', () => {
    const { frames, onsets } = matrices(24);
    activate(frames, 62, 0, 24, .72);
    onsets[0][62 - MIDI_OFFSET] = .88;
    onsets[5][62 - MIDI_OFFSET] = .82;
    const melody = decodePredominantMelody(frames, onsets);
    expect(melody.map(note => note.midi)).toEqual([62]);
  });

  it('does not turn weak peaks on stable activity into duplicate cues', () => {
    const { frames, onsets } = matrices(36);
    activate(frames, 64, 4, 32, .92);
    onsets[4][64 - MIDI_OFFSET] = .8;
    onsets[12][64 - MIDI_OFFSET] = .57;
    onsets[20][64 - MIDI_OFFSET] = .52;

    expect(decodePredominantMelody(frames, onsets).map(note => note.midi)).toEqual([64]);
  });

  it('does not invent notes from weak background activations', () => {
    const { frames, onsets } = matrices(30);
    activate(frames, 60, 0, 30, .08);
    onsets[0][60 - MIDI_OFFSET] = .2;
    expect(decodePredominantMelody(frames, onsets)).toEqual([]);
  });
});

describe('GAME chunk and instrumental-gap post-processing', () => {
  it('trims chunk-edge sustain overlap without dropping distinct attacks', () => {
    const notes = normalizeMonophonicNotes([
      { start: 1, duration: .7, midi: 62, confidence: .9, strength: .8 },
      { start: 1.5, duration: .4, midi: 62, confidence: .9, strength: .8 },
      { start: 2.1, duration: .4, midi: 64, confidence: .9, strength: .8 },
    ], 3);

    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatchObject({ start: 1, duration: .5, midi: 62 });
    expect(notes[1]).toMatchObject({ start: 1.5, duration: .4, midi: 62 });
  });

  it('finds only long uncovered intro, bridge, and outro regions', () => {
    const melody = [
      { start: 3, duration: 1, midi: 60, confidence: .9, strength: .9 },
      { start: 5.5, duration: 1, midi: 62, confidence: .9, strength: .9 },
      { start: 9, duration: 1, midi: 64, confidence: .9, strength: .9 },
    ];

    expect(findInstrumentalGaps(melody, 13)).toEqual([
      { start: 0, end: 3 },
      { start: 6.5, end: 9 },
      { start: 10, end: 13 },
    ]);
  });

  it('keeps every distinct onset but selects one upper voice per simultaneous attack', () => {
    const selected = selectInstrumentalLead([
      { startTimeSeconds: .1, durationSeconds: .4, pitchMidi: 55, amplitude: .9 },
      { startTimeSeconds: .11, durationSeconds: .5, pitchMidi: 67, amplitude: .7 },
      { startTimeSeconds: .3, durationSeconds: .4, pitchMidi: 69, amplitude: .8 },
      { startTimeSeconds: .5, durationSeconds: .4, pitchMidi: 71, amplitude: .8 },
    ], 2, { start: 2, end: 3 });

    expect(selected.map(note => note.midi)).toEqual([67, 69, 71]);
    expect(selected.map(note => note.start)).toEqual([2.11, 2.3, 2.5]);
    expect(selected[0].duration).toBe(.19);
    expect(selected[1].duration).toBe(.2);
  });
});
