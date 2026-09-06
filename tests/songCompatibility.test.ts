import { describe, expect, it } from 'vitest';
import {
  applyLocalAudioReanalysis,
  hasPlayableMelody,
  LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION,
  mergeReanalyzedLocalSong,
  needsLocalAudioRetranscription,
} from '../src/lib/songCompatibility';
import type { MelodyNote, SongAnalysis, SongRecord } from '../src/types';

function melody(count: number): MelodyNote[] {
  return Array.from({ length: count }, (_, index) => ({
    start: index * .25,
    duration: .2,
    midi: 60 + index % 8,
    confidence: .9,
    strength: .8,
  }));
}

function analysis(overrides: Partial<SongAnalysis> = {}): SongAnalysis {
  return {
    duration: 10,
    bpm: 120,
    beats: [.1, .6, 1.1],
    chords: [{ id: 'original', start: 0, end: 10, chord: 'C', confidence: .6 }],
    waveform: [.2, .4],
    key: 'C major',
    confidence: .8,
    algorithm: 'legacy',
    melody: melody(8),
    ...overrides,
  };
}

function song(overrides: Partial<SongRecord> = {}): SongRecord {
  const original = analysis();
  return {
    id: 'local-song',
    title: 'Local song',
    artist: 'Artist',
    fileName: 'song.mp3',
    audio: new Blob(['audio']),
    analysis: structuredClone(original),
    originalAnalysis: structuredClone(original),
    localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION,
    createdAt: 1,
    ...overrides,
  };
}

function freshAnalysis(): SongAnalysis {
  return analysis({
    bpm: 96,
    beats: [.2, .825, 1.45],
    chords: [{ id: 'fresh', start: 0, end: 10, chord: 'G', confidence: .88 }],
    waveform: [.8, .3, .1],
    key: 'G major',
    confidence: .91,
    algorithm: 'current full pipeline',
    melody: melody(10).map(note => ({ ...note, midi: note.midi + 5 })),
  });
}

describe('saved-song audio analysis compatibility', () => {
  it('requires full reanalysis for an old pipeline version or incomplete melody', () => {
    expect(LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION).toBe(6);
    expect(needsLocalAudioRetranscription(song())).toBe(false);
    expect(needsLocalAudioRetranscription(song({ localAnalysisPipelineVersion: undefined }))).toBe(true);
    expect(needsLocalAudioRetranscription(song({ localAnalysisPipelineVersion: 5 }))).toBe(true);
    expect(needsLocalAudioRetranscription(song({
      localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION + 1,
      analysis: analysis({ melody: undefined }),
    }))).toBe(false);

    const incomplete = analysis({ melody: melody(7) });
    expect(needsLocalAudioRetranscription(song({
      analysis: incomplete,
      originalAnalysis: structuredClone(incomplete),
    }))).toBe(true);
  });

  it('accepts a complete normalized melody and ignores invalid note padding', () => {
    expect(hasPlayableMelody(analysis())).toBe(true);
    const invalid = analysis({ melody: [...melody(7), { ...melody(1)[0], midi: 999 }] });
    expect(hasPlayableMelody(invalid)).toBe(false);
  });

  it('leaves packaged demos to their independent catalog version path', () => {
    const demo = song({
      source: { label: 'demo', url: '/demo.mp3', preview: false, version: 'demo-v1' },
      localAnalysisPipelineVersion: undefined,
      analysis: analysis({ melody: undefined }),
    });
    expect(needsLocalAudioRetranscription(demo)).toBe(false);
    expect(applyLocalAudioReanalysis(demo, freshAnalysis())).toBeNull();
  });

  it('replaces every automatic field and advances the local pipeline baseline', () => {
    const current = song({ localAnalysisPipelineVersion: undefined, title: 'Keep this title' });
    const automatic = freshAnalysis();

    const merged = mergeReanalyzedLocalSong(current, automatic);

    expect(merged).toMatchObject({
      title: 'Keep this title',
      localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION,
      analysis: automatic,
      originalAnalysis: automatic,
    });
    expect(merged.analysis).not.toBe(automatic);
    expect(merged.originalAnalysis).not.toBe(automatic);
    expect(merged.analysis).not.toBe(merged.originalAnalysis);
    merged.analysis.melody![0].midi = 40;
    merged.analysis.chords[0].chord = 'Dm';
    expect(merged.originalAnalysis.melody![0].midi).not.toBe(40);
    expect(merged.originalAnalysis.chords[0].chord).toBe('G');
  });

  it('preserves manual chord and rhythm edits while refreshing other automatic fields', () => {
    const current = song({ localAnalysisPipelineVersion: undefined });
    current.analysis = {
      ...current.analysis,
      bpm: 75,
      beats: [.15, .95, 1.75],
      chords: [{ id: 'manual', start: 0, end: 10, chord: 'Dm', confidence: 1, edited: true }],
    };
    const automatic = freshAnalysis();

    const merged = mergeReanalyzedLocalSong(current, automatic);

    expect(merged.analysis.bpm).toBe(75);
    expect(merged.analysis.beats).toEqual([.15, .95, 1.75]);
    expect(merged.analysis.chords).toEqual(current.analysis.chords);
    expect(merged.analysis.waveform).toEqual(automatic.waveform);
    expect(merged.analysis.key).toBe(automatic.key);
    expect(merged.analysis.melody).toEqual(automatic.melody);
    expect(merged.analysis.algorithm).toBe(automatic.algorithm);
    expect(merged.originalAnalysis).toEqual(automatic);
    expect(merged.analysis.beats).not.toBe(current.analysis.beats);
    expect(merged.analysis.chords).not.toBe(current.analysis.chords);
  });

  it('recognizes legacy manual edits by divergence from the saved automatic baseline', () => {
    const current = song({ localAnalysisPipelineVersion: undefined });
    current.analysis = {
      ...current.analysis,
      beats: [.2, .7, 1.2],
      chords: [{ ...current.analysis.chords[0], chord: 'Am' }],
    };

    const merged = mergeReanalyzedLocalSong(current, freshAnalysis());

    expect(merged.analysis.bpm).toBe(current.analysis.bpm);
    expect(merged.analysis.beats).toEqual(current.analysis.beats);
    expect(merged.analysis.chords).toEqual(current.analysis.chords);
  });

  it('refreshes unedited chords when only rhythm was manually changed', () => {
    const current = song({ localAnalysisPipelineVersion: 5 });
    current.analysis = { ...current.analysis, bpm: 75, beats: [.15, .95, 1.75] };

    const merged = mergeReanalyzedLocalSong(current, freshAnalysis());

    expect(merged.analysis.bpm).toBe(75);
    expect(merged.analysis.beats).toEqual([.15, .95, 1.75]);
    expect(merged.analysis.chords).toEqual(freshAnalysis().chords);
  });

  it('refreshes automatic rhythm when only chords were manually changed', () => {
    const current = song({ localAnalysisPipelineVersion: 5 });
    current.analysis = {
      ...current.analysis,
      chords: [{ id: 'manual', start: 0, end: 10, chord: 'Dm', confidence: 1, edited: true }],
    };

    const automatic = freshAnalysis();
    const merged = mergeReanalyzedLocalSong(current, automatic);

    expect(merged.analysis.bpm).toBe(automatic.bpm);
    expect(merged.analysis.beats).toEqual(automatic.beats);
    expect(merged.analysis.chords).toEqual(current.analysis.chords);
  });

  it('preserves conservative legacy edits when the old automatic baseline is missing', () => {
    const current = song({
      localAnalysisPipelineVersion: 5,
      originalAnalysis: undefined as unknown as SongAnalysis,
    });

    const merged = mergeReanalyzedLocalSong(current, freshAnalysis());

    expect(merged.analysis.bpm).toBe(current.analysis.bpm);
    expect(merged.analysis.beats).toEqual(current.analysis.beats);
    expect(merged.analysis.chords).toEqual(current.analysis.chords);
    expect(merged.originalAnalysis).toEqual(freshAnalysis());
  });

  it('does not overwrite a row that another analysis already upgraded', () => {
    const current = song();
    expect(applyLocalAudioReanalysis(current, freshAnalysis())).toBe(current);
  });

  it('rejects an unusable new analysis', () => {
    const current = song({ localAnalysisPipelineVersion: undefined });
    expect(() => mergeReanalyzedLocalSong(current, analysis({ melody: melody(7) }))).toThrow('逐音旋律音符过少');
  });
});
