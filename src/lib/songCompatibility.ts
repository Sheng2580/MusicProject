import type { SongAnalysis, SongRecord } from '../types';
import { normalizeMelodyNotes } from './performanceChart';

const MIN_PLAYABLE_MELODY_NOTES = 8;
// Version 6 replaces full-mix Basic Pitch path selection with chunked GAME
// singing-note inference and limits Basic Pitch to long instrumental gaps.
export const LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION = 6;

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function sameChordGrid(left: SongAnalysis['chords'], right: SongAnalysis['chords']): boolean {
  return left.length === right.length && left.every((segment, index) => {
    const other = right[index];
    return other !== undefined
      && segment.id === other.id
      && Object.is(segment.start, other.start)
      && Object.is(segment.end, other.end)
      && segment.chord === other.chord
      && Object.is(segment.confidence, other.confidence)
      && Boolean(segment.edited) === Boolean(other.edited);
  });
}

function hasManualRhythm(song: SongRecord): boolean {
  const original = song.originalAnalysis;
  return !original
    || !Object.is(song.analysis.bpm, original.bpm)
    || !sameNumbers(song.analysis.beats, original.beats);
}

function hasManualChords(song: SongRecord): boolean {
  const original = song.originalAnalysis;
  return song.analysis.chords.some(segment => segment.edited)
    || !original
    || !sameChordGrid(song.analysis.chords, original.chords);
}

export function hasPlayableMelody(analysis: Pick<SongAnalysis, 'duration' | 'melody'>): boolean {
  return normalizeMelodyNotes(analysis.melody, analysis.duration).length >= MIN_PLAYABLE_MELODY_NOTES;
}

/** Old or incomplete local records must be rebuilt from their saved audio. */
export function needsLocalAudioRetranscription(song: SongRecord): boolean {
  if (song.source) return false;
  const version = song.localAnalysisPipelineVersion;
  // An older tab must not downgrade a row written by a newer application build.
  if (typeof version === 'number' && Number.isFinite(version) && version > LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION) return false;
  return version !== LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION || !hasPlayableMelody(song.analysis);
}

/**
 * Apply a complete new local-audio analysis while retaining edits made against
 * the previous automatic baseline. The latest stored row must be passed here so
 * edits committed while analysis was running are also preserved.
 */
export function mergeReanalyzedLocalSong(song: SongRecord, automatic: SongAnalysis): SongRecord {
  if (song.source) throw new Error('内置曲目必须使用曲库版本升级流程');
  if (!hasPlayableMelody(automatic)) throw new Error('逐音旋律音符过少');

  const keepRhythm = hasManualRhythm(song);
  const keepChords = hasManualChords(song);
  const originalAnalysis = structuredClone(automatic);
  const analysis: SongAnalysis = {
    ...structuredClone(automatic),
    bpm: keepRhythm ? song.analysis.bpm : automatic.bpm,
    beats: keepRhythm ? song.analysis.beats.map(beat => beat) : automatic.beats.map(beat => beat),
    chords: structuredClone(keepChords ? song.analysis.chords : automatic.chords),
  };

  return {
    ...song,
    analysis,
    originalAnalysis,
    localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION,
  };
}

/** Resolve a conditional transaction against its latest stored row. */
export function applyLocalAudioReanalysis(song: SongRecord, automatic: SongAnalysis): SongRecord | null {
  if (song.source) return null;
  if (!needsLocalAudioRetranscription(song)) return song;
  return mergeReanalyzedLocalSong(song, automatic);
}
