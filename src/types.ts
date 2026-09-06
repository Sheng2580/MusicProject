export interface ChordSegment {
  id: string;
  start: number;
  end: number;
  chord: string;
  confidence: number;
  edited?: boolean;
}

export interface MelodyNote {
  start: number;
  duration: number;
  midi: number;
  confidence: number;
  strength: number;
}

export interface PracticeCue {
  id: string;
  time: number;
  duration: number;
  midi: number;
  stringIndex: number;
  fret: number;
  confidence: number;
  strength: number;
  sourceIndex: number;
}

export interface PracticeHit {
  cueId: string;
  at: number;
  perfect: boolean;
}

export interface SongAnalysis {
  duration: number;
  bpm: number;
  beats: number[];
  chords: ChordSegment[];
  waveform: number[];
  key: string;
  confidence: number;
  algorithm: string;
  melody?: MelodyNote[];
}

export interface SongRecord {
  id: string;
  title: string;
  artist: string;
  fileName: string;
  cover?: string;
  audio: Blob;
  analysis: SongAnalysis;
  originalAnalysis: SongAnalysis;
  /** Version of the browser-only audio analysis pipeline used for local uploads. */
  localAnalysisPipelineVersion?: number;
  createdAt: number;
  source?: {
    label: string;
    url: string;
    preview: boolean;
    version?: string;
    backingUrl?: string;
    /** Actual Blob digest; the verified marker distinguishes it from legacy copied catalog values. */
    audioSha256?: string;
    audioSha256Verified?: true;
  };
}

export interface AnalysisProgress {
  progress: number;
  stage: string;
}

export type PlayMode = 'easy' | 'challenge' | 'free';
export type StrumDirection = 'down' | 'up';
