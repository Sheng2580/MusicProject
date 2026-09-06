import type { SongAnalysis, SongRecord } from '../types';
import { coverForAudioRevision } from './songMetadata';

const DATABASE = 'musicproject-local-library';
const STORE = 'songs';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本地曲库，请检查浏览器是否允许保存网站数据。'));
  });
}

export async function getSongs(): Promise<SongRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as SongRecord[]).sort((a, b) => a.createdAt - b.createdAt));
    request.onerror = () => reject(new Error('读取曲库失败。'));
    if (request.transaction) request.transaction.oncomplete = () => db.close();
  });
}

export async function saveSong(song: SongRecord): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(song);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(new Error('本地保存失败，可能是浏览器存储空间不足。可先导出曲谱。')); };
  });
}

/** Atomically update an existing song without recreating a deleted/replaced row. */
export async function updateSongIfFileMatches(
  id: string,
  expectedFileName: string,
  expectedVersion: string | undefined,
  update: (current: SongRecord) => SongRecord | null,
): Promise<SongRecord | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    let updated: SongRecord | null = null;
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as SongRecord | undefined;
      if (!current || current.fileName !== expectedFileName || current.source?.version !== expectedVersion) return;
      const next = update(current);
      if (!next || next.id !== current.id) return;
      updated = next;
      store.put(next);
    };
    transaction.oncomplete = () => { db.close(); resolve(updated); };
    transaction.onabort = () => { db.close(); reject(new Error('歌曲升级失败，请刷新页面后重试。')); };
    transaction.onerror = () => { /* onabort reports the transaction failure once. */ };
  });
}

/**
 * Replace an older audio revision without recreating a song deleted while the
 * replacement was being analyzed.
 */
export async function replaceSongIfFileMatches(
  replacement: SongRecord,
  expectedFileName: string,
  expectedVersion?: string,
  expectedAnalysis?: SongAnalysis,
): Promise<boolean> {
  const updated = await updateSongIfFileMatches(
    replacement.id,
    expectedFileName,
    expectedVersion,
    current => {
      if (expectedAnalysis && JSON.stringify(current.analysis) !== JSON.stringify(expectedAnalysis)) return null;
      return {
        ...replacement,
        createdAt: current.createdAt,
        cover: coverForAudioRevision(current.cover, replacement.cover),
      };
    },
  );
  return updated !== null;
}

export async function removeSong(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(new Error('移除歌曲失败。')); };
  });
}

type SongAudioRevision = Pick<SongRecord, 'id' | 'fileName' | 'audio' | 'createdAt' | 'source'>;

export function sameSongAudioRevision(current: SongAudioRevision, expected: SongAudioRevision): boolean {
  return current.id === expected.id
    && current.fileName === expected.fileName
    && current.audio.size === expected.audio.size
    && current.audio.type === expected.audio.type
    && current.createdAt === expected.createdAt
    && current.source?.version === expected.source?.version
    && current.source?.audioSha256 === expected.source?.audioSha256;
}

/** Add artwork only while the audio revision that supplied it is still current. */
export async function saveSongCover(expected: SongAudioRevision, cover: string, replaceExisting = false): Promise<boolean> {
  const updated = await updateSongIfFileMatches(
    expected.id,
    expected.fileName,
    expected.source?.version,
    current => {
      if (!sameSongAudioRevision(current, expected)) return null;
      return replaceExisting || !current.cover ? { ...current, cover } : current;
    },
  );
  return updated !== null;
}
