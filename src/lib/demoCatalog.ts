import type { MelodyNote, SongAnalysis, SongRecord } from '../types';
import { normalizeKnownTempo } from './performanceChart';

const LEGACY_DEMO_IDS = ['see-you-again', 'xiao-mei-man'];
const MELODY_ALGORITHM_MARKER = '预计算主旋律音高轨';

export interface DemoAudioDescriptor {
  fileName: string;
  audioBytes: number;
  audioSha256: string;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

export function attachDemoMelody(analysis: SongAnalysis, melody: MelodyNote[], bpm?: number): SongAnalysis {
  const timed = bpm === undefined ? analysis : normalizeKnownTempo(analysis, bpm);
  return {
    ...timed,
    melody: melody.map(note => ({ ...note })),
    algorithm: timed.algorithm.includes(MELODY_ALGORITHM_MARKER)
      ? timed.algorithm
      : `${timed.algorithm} / ${MELODY_ALGORITHM_MARKER}`,
  };
}

/** Merge a melody-only catalog update against the latest saved edit state. */
export function mergeDemoMelodyUpgrade(
  song: Pick<SongRecord, 'analysis' | 'originalAnalysis'>,
  melody: MelodyNote[],
  catalogBpm?: number,
): Pick<SongRecord, 'analysis' | 'originalAnalysis'> {
  const manualRhythm = !Object.is(song.analysis.bpm, song.originalAnalysis.bpm)
    || !sameNumbers(song.analysis.beats, song.originalAnalysis.beats);
  return {
    analysis: attachDemoMelody(song.analysis, melody, manualRhythm ? undefined : catalogBpm),
    originalAnalysis: attachDemoMelody(song.originalAnalysis, melody, catalogBpm),
  };
}

function normalizedSha256(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function expectedDemoFingerprint(track: DemoAudioDescriptor): { bytes: number; sha256: string } | null {
  const sha256 = normalizedSha256(track.audioSha256);
  if (!Number.isInteger(track.audioBytes) || track.audioBytes <= 0 || !sha256) return null;
  return { bytes: track.audioBytes, sha256 };
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前浏览器无法校验内置音频完整性。');
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Verify downloaded bytes before any precomputed analysis is attached. */
export async function verifyDemoAudio(blob: Blob, track: DemoAudioDescriptor): Promise<string> {
  const expected = expectedDemoFingerprint(track);
  if (!expected) throw new Error('内置曲目的音频校验信息无效。');
  if (blob.size !== expected.bytes) throw new Error('内置音频文件大小不符，请刷新后重试。');
  const actual = await sha256Blob(blob);
  if (actual !== expected.sha256) throw new Error('内置音频完整性校验失败，请刷新后重试。');
  return actual;
}

/** Distinguish a melody-only catalog update from an updated recording. */
export async function demoAudioMatches(
  saved: Pick<SongRecord, 'fileName' | 'audio' | 'source'>,
  track: DemoAudioDescriptor,
): Promise<boolean> {
  if (saved.fileName !== track.fileName) return false;
  const expected = expectedDemoFingerprint(track);
  if (!expected || saved.audio.size !== expected.bytes) return false;

  // Older builds copied the catalog hash without hashing the Blob. The marker
  // is only written after verifyDemoAudio succeeds, so those records rebuild.
  if (saved.source?.audioSha256Verified !== true) return false;
  const persisted = normalizedSha256(saved.source.audioSha256);
  if (persisted !== expected.sha256) return false;
  try {
    return await sha256Blob(saved.audio) === expected.sha256;
  } catch {
    return false;
  }
}

/**
 * The old boolean marker represented the two-track catalog above. Keeping that
 * knowledge lets new catalog IDs install once without resurrecting old demos
 * that a player deliberately removed.
 */
export function readKnownDemoIds(serialized: string | null, legacyInitialized: boolean): Set<string> {
  if (serialized) {
    try {
      const value: unknown = JSON.parse(serialized);
      if (Array.isArray(value)) return new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0));
    } catch { /* A corrupt marker is rebuilt from the legacy state below. */ }
  }
  return new Set(legacyInitialized ? LEGACY_DEMO_IDS : []);
}

export function serializeKnownDemoIds(ids: Iterable<string>): string {
  return JSON.stringify([...new Set(ids)].sort());
}
