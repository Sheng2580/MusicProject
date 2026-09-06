import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MelodyNote, SongAnalysis } from '../src/types';

const transcribeMelody = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/melodyTranscription', () => ({
  MELODY_MODEL_SAMPLE_RATE: 44_100,
  MELODY_TRANSCRIPTION_ALGORITHM: 'OpenVPI GAME test melody',
  transcribeMelody,
}));

import { analyzeAudio } from '../src/lib/analysis';

const workerAnalysis: SongAnalysis = {
  duration: 1,
  bpm: 120,
  beats: [0, .5],
  chords: [{ id: 'chord-0', start: 0, end: 1, chord: 'C', confidence: .8 }],
  waveform: [.2, .5, .3],
  key: 'C',
  confidence: .8,
  algorithm: 'test worker',
};

function melodyNotes(): MelodyNote[] {
  return Array.from({ length: 8 }, (_, index) => ({
    start: index * .1,
    duration: .08,
    midi: 60 + index,
    confidence: .9,
    strength: .8,
  }));
}

class MockAudioContext {
  async decodeAudioData() { return { duration: 1 }; }
  async close() { /* no-op */ }
}

class MockOfflineAudioContext {
  static sampleRates: number[] = [];
  private readonly samples: Float32Array;

  constructor(_channels: number, length: number, sampleRate: number) {
    MockOfflineAudioContext.sampleRates.push(sampleRate);
    this.samples = new Float32Array(length);
  }

  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, disconnect() {} };
  }

  async startRendering() {
    return { getChannelData: () => this.samples };
  }
}

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  postMessage() {
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: 'progress', progress: { progress: .75, stage: '正在分析节拍' } } } as MessageEvent);
      this.onmessage?.({ data: { type: 'result', analysis: structuredClone(workerAnalysis) } } as MessageEvent);
    });
  }

  terminate() { /* no-op */ }
}

describe('audio-only browser analysis flow', () => {
  beforeEach(() => {
    MockOfflineAudioContext.sampleRates = [];
    transcribeMelody.mockReset();
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('OfflineAudioContext', MockOfflineAudioContext);
    vi.stubGlobal('Worker', MockWorker);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('transcribes a playable note track by default and only reaches 100% after it finishes', async () => {
    transcribeMelody.mockImplementation(async (_samples: Float32Array, onProgress?: (progress: number) => void) => {
      onProgress?.(.15);
      onProgress?.(.8);
      return melodyNotes();
    });
    const updates: { progress: number; stage: string }[] = [];

    const result = await analyzeAudio(new Blob(['valid audio']), update => updates.push(update));

    expect(transcribeMelody).toHaveBeenCalledOnce();
    expect(result.melody).toHaveLength(8);
    expect(result.algorithm).toContain('OpenVPI GAME');
    expect(MockOfflineAudioContext.sampleRates).toEqual([44_100]);
    expect(updates.map(update => update.progress)).toEqual(
      [...updates.map(update => update.progress)].sort((left, right) => left - right),
    );
    expect(updates.filter(update => update.progress === 1)).toEqual([
      { progress: 1, stage: '本地逐音分析完成' },
    ]);
  });

  it('only skips melody transcription when the caller explicitly supplies a precomputed track', async () => {
    const updates: number[] = [];

    const result = await analyzeAudio(new Blob(['demo audio']), update => updates.push(update.progress), { melody: false });

    expect(transcribeMelody).not.toHaveBeenCalled();
    expect(result.melody).toBeUndefined();
    expect(MockOfflineAudioContext.sampleRates).toEqual([11_025]);
    expect(updates.at(-1)).toBe(1);
  });

  it('turns model-loading failures into an actionable player-facing error', async () => {
    transcribeMelody.mockRejectedValue(new Error('backend fetch failed'));

    await expect(analyzeAudio(new Blob(['valid audio']))).rejects.toThrow('逐音旋律识别失败');
  });
});
