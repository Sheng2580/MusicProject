import { renderAccompaniment } from './accompaniment';
import type { SongRecord } from '../types';

export type BackingKind = 'separated' | 'generated';

interface BackingResponse {
  ok: boolean;
  status: number;
  blob(): Promise<Blob>;
}

interface ResolveBackingOptions {
  signal?: AbortSignal;
  fetcher?: (url: string, init?: RequestInit) => Promise<BackingResponse>;
  renderer?: typeof renderAccompaniment;
}

export interface ResolvedBacking {
  blob: Blob;
  kind: BackingKind;
  fallbackError?: Error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('真实伴奏读取失败');
}

/** Prefer a supplied no-vocals stem while keeping local uploads backward-compatible. */
export async function resolveBackingTrack(
  song: Pick<SongRecord, 'analysis' | 'source'>,
  practiceRate = 1,
  options: ResolveBackingOptions = {},
): Promise<ResolvedBacking> {
  const renderer = options.renderer ?? renderAccompaniment;
  const backingUrl = song.source?.backingUrl;
  if (!backingUrl) return { blob: renderer(song.analysis, practiceRate), kind: 'generated' };

  try {
    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(backingUrl, { cache: 'force-cache', signal: options.signal });
    if (!response.ok) throw new Error(`真实伴奏读取失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('真实伴奏文件为空');
    return { blob, kind: 'separated' };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return {
      blob: renderer(song.analysis, practiceRate),
      kind: 'generated',
      fallbackError: asError(error),
    };
  }
}
