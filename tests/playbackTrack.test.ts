import { describe, expect, it, vi } from 'vitest';
import { resolveBackingTrack } from '../src/lib/playbackTrack';
import type { SongAnalysis, SongRecord } from '../src/types';

const analysis: SongAnalysis = {
  duration: 1,
  bpm: 120,
  beats: [0, 0.5],
  chords: [],
  waveform: [],
  key: 'C',
  confidence: 1,
  algorithm: 'test',
};

function song(backingUrl?: string): Pick<SongRecord, 'analysis' | 'source'> {
  return {
    analysis,
    source: { label: 'test', url: 'https://example.com', preview: false, backingUrl },
  };
}

describe('playback backing selection', () => {
  it('uses the real no-vocals track when one is available', async () => {
    const backing = new Blob(['separated'], { type: 'audio/mp4' });
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, blob: async () => backing }));
    const renderer = vi.fn(() => new Blob(['generated']));

    const result = await resolveBackingTrack(song('/demo/backing.m4a'), 1, { fetcher, renderer });

    expect(fetcher).toHaveBeenCalledWith('/demo/backing.m4a', expect.objectContaining({ cache: 'force-cache' }));
    expect(renderer).not.toHaveBeenCalled();
    expect(result).toEqual({ blob: backing, kind: 'separated' });
  });

  it('falls back to generated accompaniment when the real track cannot load', async () => {
    const generated = new Blob(['generated'], { type: 'audio/wav' });
    const fetcher = vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() }));
    const renderer = vi.fn(() => generated);

    const result = await resolveBackingTrack(song('/demo/missing.m4a'), 0.75, { fetcher, renderer });

    expect(result.blob).toBe(generated);
    expect(result.kind).toBe('generated');
    expect(result.fallbackError?.message).toContain('HTTP 404');
    expect(renderer).toHaveBeenCalledWith(analysis, 0.75);
  });

  it('keeps old records and local uploads on generated accompaniment', async () => {
    const generated = new Blob(['generated'], { type: 'audio/wav' });
    const renderer = vi.fn(() => generated);
    const fetcher = vi.fn();

    const result = await resolveBackingTrack({ analysis }, 1, { fetcher, renderer });

    expect(result).toEqual({ blob: generated, kind: 'generated' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not synthesize a stale request after it has been aborted', async () => {
    const controller = new AbortController();
    const renderer = vi.fn(() => new Blob(['generated']));
    const fetcher = vi.fn(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    await expect(resolveBackingTrack(song('/demo/backing.m4a'), 1, {
      signal: controller.signal,
      fetcher,
      renderer,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(renderer).not.toHaveBeenCalled();
  });
});
