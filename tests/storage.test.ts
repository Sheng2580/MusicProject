import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSongs,
  removeSong,
  replaceSongIfFileMatches,
  sameSongAudioRevision,
  saveSong,
  saveSongCover,
  updateSongIfFileMatches,
} from '../src/lib/storage';
import { applyLocalAudioReanalysis, LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION } from '../src/lib/songCompatibility';
import type { SongAnalysis, SongRecord } from '../src/types';

type Request<T = unknown> = {
  result?: T;
  error?: unknown;
  onsuccess?: (event: Event) => void;
  onerror?: (event: Event) => void;
  onupgradeneeded?: (event: Event) => void;
  transaction?: Transaction;
};

type Transaction = {
  oncomplete?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  objectStore: () => ReturnType<typeof createStore>;
};

function installMemoryIndexedDb() {
  const rows = new Map<string, SongRecord>();
  let created = false;

  const createTransaction = (): Transaction => {
    let pending = 0;
    let completed = false;
    const transaction = {} as Transaction;
    const finish = () => queueMicrotask(() => {
      if (!completed && pending === 0) {
        completed = true;
        transaction.oncomplete?.();
      }
    });
    const request = <T>(operation: () => T): Request<T> => {
      const next: Request<T> = { transaction };
      pending++;
      queueMicrotask(() => {
        try {
          next.result = operation();
          next.onsuccess?.(new Event('success'));
        } catch (error) {
          next.error = error;
          next.onerror?.(new Event('error'));
          transaction.onerror?.();
          transaction.onabort?.();
          completed = true;
        } finally {
          pending--;
          finish();
        }
      });
      return next;
    };
    transaction.objectStore = () => createStore(rows, request);
    return transaction;
  };

  const database = {
    createObjectStore() { /* The in-memory map already represents the store. */ },
    transaction() { return createTransaction(); },
    close() { /* no-op */ },
  };
  const factory = {
    open() {
      const request: Request<typeof database> = {};
      queueMicrotask(() => {
        request.result = database;
        if (!created) {
          created = true;
          request.onupgradeneeded?.(new Event('upgradeneeded'));
        }
        request.onsuccess?.(new Event('success'));
      });
      return request;
    },
  };
  vi.stubGlobal('indexedDB', factory as unknown as IDBFactory);
}

function createStore(
  rows: Map<string, SongRecord>,
  request: <T>(operation: () => T) => Request<T>,
) {
  return {
    get(id: string) {
      return request(() => {
        const row = rows.get(id);
        return row ? structuredClone(row) : undefined;
      });
    },
    getAll() {
      return request(() => [...rows.values()].map(row => structuredClone(row)));
    },
    put(song: SongRecord) {
      return request(() => {
        rows.set(song.id, structuredClone(song));
        return song.id;
      });
    },
    delete(id: string) {
      return request(() => rows.delete(id));
    },
  };
}

function analysis(chord = 'C'): SongAnalysis {
  return {
    duration: 10,
    bpm: 120,
    beats: [0, .5, 1],
    chords: [{ id: 'chord-0', start: 0, end: 10, chord, confidence: .8 }],
    waveform: [.2, .5],
    key: 'C',
    confidence: .8,
    algorithm: 'test',
  };
}

function song(overrides: Partial<SongRecord> = {}): SongRecord {
  const original = analysis();
  return {
    id: 'song-1',
    title: 'Song',
    artist: 'Artist',
    fileName: 'song.mp3',
    audio: new Blob(['audio']),
    analysis: original,
    originalAnalysis: structuredClone(original),
    createdAt: 10,
    source: { label: 'demo', url: '/demo.mp3', preview: false, version: 'v1' },
    ...overrides,
  };
}

describe('transactional song updates', () => {
  beforeEach(installMemoryIndexedDb);
  afterEach(() => vi.unstubAllGlobals());

  it('runs an updater against the latest stored row and preserves unrelated fields', async () => {
    await saveSong(song());
    await saveSong(song({ title: 'Edited while analysis ran', cover: 'cover-data', createdAt: 25 }));

    const updated = await updateSongIfFileMatches('song-1', 'song.mp3', 'v1', current => ({
      ...current,
      analysis: { ...current.analysis, bpm: 96 },
    }));

    expect(updated?.title).toBe('Edited while analysis ran');
    expect(updated?.cover).toBe('cover-data');
    expect(updated?.createdAt).toBe(25);
    expect((await getSongs())[0].analysis.bpm).toBe(96);
  });

  it('keeps an existing cover by default but lets verified embedded art replace it', async () => {
    const current = song({ cover: 'https://example.com/thumbnail.jpg' });
    await saveSong(current);

    await saveSongCover(current, 'data:image/png;base64,ignored');
    expect((await getSongs())[0].cover).toBe('https://example.com/thumbnail.jpg');

    await saveSongCover(current, 'data:image/png;base64,embedded', true);
    expect((await getSongs())[0].cover).toBe('data:image/png;base64,embedded');
  });

  it('does not save artwork parsed from a stale audio revision', async () => {
    const stale = song({ cover: undefined });
    await saveSong(stale);
    const current = song({
      cover: 'data:image/png;base64,current',
      audio: new Blob(['replacement audio'], { type: 'audio/mpeg' }),
      source: { ...stale.source!, version: 'v2', audioSha256: 'new-digest', audioSha256Verified: true },
    });
    await saveSong(current);

    expect(await saveSongCover(stale, 'data:image/png;base64,stale', true)).toBe(false);
    expect((await getSongs())[0].cover).toBe('data:image/png;base64,current');
  });

  it('merges a full local reanalysis against the latest manual edits in one transaction', async () => {
    const notes = Array.from({ length: 8 }, (_, index) => ({
      start: index * .5, duration: .3, midi: 60 + index, confidence: .9, strength: .8,
    }));
    const baseline = { ...analysis(), melody: notes };
    const local = song({
      source: undefined,
      analysis: structuredClone(baseline),
      originalAnalysis: structuredClone(baseline),
      localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION - 1,
    });
    await saveSong(local);

    const edited = {
      ...local,
      title: 'Renamed while analysis ran',
      analysis: {
        ...structuredClone(baseline),
        bpm: 88,
        beats: [.2, .88, 1.56],
        chords: [{ id: 'manual', start: 0, end: 10, chord: 'Dm', confidence: 1, edited: true }],
      },
    };
    await saveSong(edited);
    const automatic = {
      ...analysis('G'),
      bpm: 96,
      beats: [.1, .725, 1.35],
      waveform: [.9, .4, .2],
      key: 'G major',
      algorithm: 'current pipeline',
      melody: notes.map(note => ({ ...note, midi: note.midi + 5 })),
    };

    const updated = await updateSongIfFileMatches(
      local.id,
      local.fileName,
      undefined,
      current => applyLocalAudioReanalysis(current, automatic),
    );

    expect(updated).toMatchObject({
      title: 'Renamed while analysis ran',
      localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION,
      analysis: {
        bpm: 88,
        beats: [.2, .88, 1.56],
        chords: [{ chord: 'Dm', edited: true }],
        waveform: automatic.waveform,
        key: automatic.key,
        melody: automatic.melody,
      },
      originalAnalysis: automatic,
    });
    expect((await getSongs())[0]).toEqual(updated);
  });

  it('keeps a concurrently completed current pipeline result instead of applying stale analysis', async () => {
    const notes = Array.from({ length: 8 }, (_, index) => ({
      start: index * .5, duration: .3, midi: 60 + index, confidence: .9, strength: .8,
    }));
    const currentAnalysis = { ...analysis('G'), algorithm: 'newer result', melody: notes };
    const current = song({
      source: undefined,
      analysis: structuredClone(currentAnalysis),
      originalAnalysis: structuredClone(currentAnalysis),
      localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION,
    });
    await saveSong(current);
    const stale = { ...analysis('Dm'), algorithm: 'stale result', melody: notes.map(note => ({ ...note, midi: note.midi + 4 })) };

    const updated = await updateSongIfFileMatches(
      current.id,
      current.fileName,
      undefined,
      latest => applyLocalAudioReanalysis(latest, stale),
    );

    expect(updated?.analysis.algorithm).toBe('newer result');
    expect(updated?.analysis.melody).toEqual(notes);
    expect((await getSongs())[0].analysis.algorithm).toBe('newer result');
  });

  it('does not attach an old-audio analysis to a concurrently replaced local audio blob', async () => {
    const notes = Array.from({ length: 8 }, (_, index) => ({
      start: index * .5, duration: .3, midi: 60 + index, confidence: .9, strength: .8,
    }));
    const baseline = { ...analysis(), melody: notes };
    const stale = song({
      source: undefined,
      audio: new Blob(['old audio'], { type: 'audio/mpeg' }),
      analysis: structuredClone(baseline),
      originalAnalysis: structuredClone(baseline),
      localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION - 1,
    });
    await saveSong(stale);
    const replacement = {
      ...stale,
      audio: new Blob(['different replacement audio'], { type: 'audio/mpeg' }),
    };
    await saveSong(replacement);

    const automatic = {
      ...analysis('G'),
      algorithm: 'stale old-audio result',
      melody: notes.map(note => ({ ...note, midi: note.midi + 5 })),
    };
    const updated = await updateSongIfFileMatches(
      stale.id,
      stale.fileName,
      undefined,
      current => sameSongAudioRevision(current, stale)
        ? applyLocalAudioReanalysis(current, automatic)
        : null,
    );

    expect(updated).toBeNull();
    expect((await getSongs())[0]).toEqual(replacement);
  });

  it('does not update a deleted row or a different file revision', async () => {
    await saveSong(song());
    expect(await updateSongIfFileMatches('song-1', 'other.mp3', 'v1', current => current)).toBeNull();
    expect(await updateSongIfFileMatches('song-1', 'song.mp3', 'v2', current => current)).toBeNull();
    expect(await updateSongIfFileMatches('song-1', 'song.mp3', 'v1', () => null)).toBeNull();
    expect((await getSongs())[0].title).toBe('Song');

    await removeSong('song-1');
    expect(await updateSongIfFileMatches('song-1', 'song.mp3', 'v1', current => current)).toBeNull();
    expect(await getSongs()).toEqual([]);
  });

  it('rejects a replacement after the analysis changed and retains the newer edit', async () => {
    const stale = song();
    await saveSong(stale);
    const edited = song({ analysis: analysis('Dm') });
    edited.analysis.chords[0].edited = true;
    await saveSong(edited);

    const replacement = song({ analysis: analysis('G'), createdAt: 999, cover: 'replacement-cover' });
    const replaced = await replaceSongIfFileMatches(
      replacement,
      stale.fileName,
      stale.source?.version,
      stale.analysis,
    );

    expect(replaced).toBe(false);
    expect((await getSongs())[0].analysis.chords[0]).toMatchObject({ chord: 'Dm', edited: true });
  });

  it('preserves current creation time and cover during an accepted replacement', async () => {
    const current = song({ createdAt: 25, cover: 'current-cover' });
    await saveSong(current);
    const replacement = song({ analysis: analysis('G'), createdAt: 999, cover: 'replacement-cover' });

    expect(await replaceSongIfFileMatches(
      replacement,
      current.fileName,
      current.source?.version,
      current.analysis,
    )).toBe(true);

    expect((await getSongs())[0]).toMatchObject({
      createdAt: 25,
      cover: 'current-cover',
      analysis: { chords: [{ chord: 'G' }] },
    });
  });

  it('uses embedded artwork carried by an accepted replacement audio file', async () => {
    const current = song({ createdAt: 25, cover: 'data:image/png;base64,old' });
    await saveSong(current);
    const replacement = song({
      analysis: analysis('G'),
      createdAt: 999,
      cover: 'data:image/jpeg;base64,new',
    });

    expect(await replaceSongIfFileMatches(
      replacement,
      current.fileName,
      current.source?.version,
      current.analysis,
    )).toBe(true);

    expect((await getSongs())[0]).toMatchObject({
      createdAt: 25,
      cover: 'data:image/jpeg;base64,new',
    });
  });
});
