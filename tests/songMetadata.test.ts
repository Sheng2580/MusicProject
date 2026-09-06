import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let metadata: typeof import('../src/lib/songMetadata');
const encoder = new TextEncoder();
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfkAAAAASUVORK5CYII='), character => character.charCodeAt(0));
const coverUrl = 'https://is1-ssl.mzstatic.com/image/thumb/Music/test/100x100bb.jpg';
const highResolutionCoverUrl = 'https://is1-ssl.mzstatic.com/image/thumb/Music/test/1000x1000bb.jpg';

function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function latin(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

function bigEndian(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function syncSafe(value: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(value >>> 21) & 127, (value >>> 14) & 127, (value >>> 7) & 127, value & 127]);
}

function mp3WithPictures(pictures: { format: string; type: number; data: Uint8Array; description?: string }[]): Blob {
  const frame = (id: string, data: Uint8Array) => join(latin(id), syncSafe(data.length), new Uint8Array(2), data);
  const tags = join(
    frame('TIT2', join(new Uint8Array([3]), encoder.encode('内嵌歌曲'))),
    frame('TPE1', join(new Uint8Array([3]), encoder.encode('内嵌歌手'))),
    ...pictures.map(picture => frame('APIC', join(
      new Uint8Array([3]), latin(`${picture.format}\0`), new Uint8Array([picture.type]),
      encoder.encode(picture.description ?? ''), new Uint8Array([0]), picture.data,
    ))),
  );
  const header = join(latin('ID3'), new Uint8Array([4, 0, 0]), syncSafe(tags.length));
  const audioFrame = new Uint8Array(417);
  audioFrame.set([0xff, 0xfb, 0x90, 0x64]);
  return new Blob([join(header, tags, audioFrame, audioFrame, audioFrame)], { type: 'audio/mpeg' });
}

function mp3WithTags(): Blob {
  return mp3WithPictures([{ format: 'image/png', type: 3, data: png }]);
}

function m4aWithTags(): Blob {
  const atom = (name: string, contents: Uint8Array) => join(bigEndian(contents.length + 8), latin(name), contents);
  const tag = (name: string, contents: Uint8Array, type = 1) => atom(name, atom('data', join(bigEndian(type), new Uint8Array(4), contents)));
  const ilst = atom('ilst', join(
    tag('©nam', encoder.encode('MP4 title')),
    tag('©ART', encoder.encode('MP4 artist')),
    tag('covr', png, 14),
  ));
  const moov = atom('moov', atom('udta', atom('meta', join(new Uint8Array(4), ilst))));
  const ftyp = atom('ftyp', join(latin('M4A '), new Uint8Array(4), latin('M4A isom')));
  return new Blob([join(ftyp, moov)], { type: 'audio/mp4' });
}

function catalog(results: unknown[]) {
  return { ok: true, json: async () => ({ resultCount: results.length, results }) };
}

function track(trackName = 'Bright Horizon', artistName = 'Example Artist', extra: Record<string, unknown> = {}) {
  return { kind: 'song', trackName, artistName, artworkUrl100: coverUrl, ...extra };
}

beforeEach(async () => {
  vi.resetModules();
  metadata = await import('../src/lib/songMetadata');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local file metadata', () => {
  it('recognizes only supported embedded image data URLs', () => {
    expect(metadata.isEmbeddedCover('data:image/jpeg;base64,abc')).toBe(true);
    expect(metadata.isEmbeddedCover('DATA:image/png;base64,abc')).toBe(true);
    expect(metadata.isEmbeddedCover('data:image/svg+xml;base64,abc')).toBe(false);
    expect(metadata.isEmbeddedCover('https://example.com/cover.jpg')).toBe(false);
    expect(metadata.isEmbeddedCover(undefined)).toBe(false);
  });

  it('reads real ID3 title, artist and front-cover tags without uploading the file', async () => {
    const fetch = vi.fn(() => { throw new Error('Local tags must not use the network'); });
    vi.stubGlobal('fetch', fetch);
    const result = await metadata.readSongMetadata(mp3WithTags(), 'Wrong Artist - Wrong Title.mp3');
    expect(result.title).toBe('内嵌歌曲');
    expect(result.artist).toBe('内嵌歌手');
    expect(result.cover).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...png))}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefers the front APIC image even when a back cover appears first', async () => {
    const back = new Uint8Array([1, 2, 3]);
    const front = new Uint8Array([4, 5, 6]);
    const result = await metadata.readSongMetadata(mp3WithPictures([
      { format: 'image/png', type: 4, data: back, description: 'cover' },
      { format: 'image/jpeg', type: 3, data: front },
    ]), 'song.mp3');

    expect(result.cover).toBe(`data:image/jpeg;base64,${btoa(String.fromCharCode(...front))}`);
  });

  it('skips an unsupported preferred image and uses the next valid embedded picture', async () => {
    const fallback = new Uint8Array([7, 8, 9]);
    const result = await metadata.readSongMetadata(mp3WithPictures([
      { format: 'image/bmp', type: 3, data: new Uint8Array([1]) },
      { format: 'image/png', type: 4, data: fallback },
    ]), 'song.mp3');

    expect(result.cover).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...fallback))}`);
  });

  it('reads iTunes MP4 title, artist and embedded artwork atoms', async () => {
    const result = await metadata.readSongMetadata(m4aWithTags(), 'Fallback.m4a');
    expect(result.title).toBe('MP4 title');
    expect(result.artist).toBe('MP4 artist');
    expect(result.cover).toMatch(/^data:image\/png;base64,/);
  });

  it('falls back to Artist - Title when tags are absent or malformed', async () => {
    const result = await metadata.readSongMetadata(new Blob(['not audio']), '周深 - 小美满.mp3');
    expect(result).toEqual({ title: '小美满', artist: '周深' });
  });

  it('keeps hyphenated titles intact and removes only the final extension', async () => {
    expect(await metadata.readSongMetadata(new Blob(), 'My-Song.v2.wav')).toEqual({ title: 'My-Song.v2' });
    expect(await metadata.readSongMetadata(new Blob(), '01. Artist — Title - Live.flac')).toEqual({ title: 'Title - Live', artist: 'Artist' });
    expect(await metadata.readSongMetadata(new Blob(), '.mp3')).toEqual({ title: '未命名曲目' });
  });
});

describe('automatic catalog cover matching', () => {
  it('ignores an unrelated first result and uses exact normalized title and artist', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => catalog([track('Different Song'), track('Bright Horizon', 'Wrong Artist'), track()]));
    vi.stubGlobal('fetch', fetch);
    expect(await metadata.lookupSongCover('BRIGHT—HORIZON', 'Example Artist')).toBe(highResolutionCoverUrl);
    const requestUrl = new URL(fetch.mock.calls[0][0] as unknown as string);
    expect(requestUrl.origin).toBe('https://itunes.apple.com');
    expect(requestUrl.searchParams.get('term')).toBe('BRIGHT—HORIZON Example Artist');
    expect(requestUrl.searchParams.get('entity')).toBe('song');
    const options = fetch.mock.calls[0][1] as unknown as RequestInit;
    expect(options.body).toBeUndefined();
    expect(options.credentials).toBe('omit');
  });

  it('matches feature credits without replacing the primary artist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([track('Bright Horizon (feat. Guest)', 'Example Artist')])));
    expect(await metadata.lookupSongCover('Bright Horizon', 'Example Artist (feat. Guest)')).toBe(highResolutionCoverUrl);
  });

  it('does not accept partial artist names or alternate live versions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([track('Bright Horizon', 'Anna'), track('Bright Horizon (Live)', 'Ann')])));
    expect(await metadata.lookupSongCover('Bright Horizon', 'Ann')).toBeNull();
  });

  it('returns no cover for ambiguous same-title songs without an artist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([track(), track('Bright Horizon', 'Second Artist')])));
    expect(await metadata.lookupSongCover('Bright Horizon')).toBeNull();
  });

  it('can match a title without an artist when matching results have one performer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([track(), track('Bright Horizon', 'Example Artist', { trackId: 2 })])));
    expect(await metadata.lookupSongCover('Bright Horizon')).toBe(highResolutionCoverUrl);
  });

  it('uses the verified Wiz Khalifa recording ID for the original demo', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => catalog([track('See You Again (feat. Charlie Puth)', 'Wiz Khalifa', { trackId: 966411602 })]));
    vi.stubGlobal('fetch', fetch);
    expect(await metadata.lookupSongCover('See You Again', 'Wiz Khalifa feat. Charlie Puth')).toBe(highResolutionCoverUrl);
    const url = new URL(fetch.mock.calls[0][0] as unknown as string);
    expect(url.pathname).toBe('/lookup');
    expect(url.searchParams.get('id')).toBe('966411602');
  });

  it('matches the verified 周深 demo across simplified, traditional and English catalog tags', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => catalog([track('小美滿 (電影《熱辣滾燙》熱辣陪伴曲)', '周深', { trackId: 1733140195 })]));
    vi.stubGlobal('fetch', fetch);
    expect(await metadata.lookupSongCover('小美满', 'Zhou Shen')).toBe(highResolutionCoverUrl);
    const url = new URL(fetch.mock.calls[0][0] as unknown as string);
    expect(url.searchParams.get('id')).toBe('1733140195');
    expect(url.searchParams.get('country')).toBe('tw');
  });

  it('still validates artist and recording ID in a preset lookup response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      track('See You Again', 'Wiz Khalifa', { trackId: 999 }),
      track('See You Again', 'Cover Artist', { trackId: 966411602 }),
    ])));
    expect(await metadata.lookupSongCover('See You Again', 'Wiz Khalifa')).toBeNull();
  });

  it('does not bind a different same-title artist to a preset', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => catalog([track('See You Again', 'Tyler, The Creator')]));
    vi.stubGlobal('fetch', fetch);
    expect(await metadata.lookupSongCover('See You Again', 'Tyler, The Creator')).toBe(highResolutionCoverUrl);
    expect(new URL(fetch.mock.calls[0][0] as unknown as string).pathname).toBe('/search');
  });

  it.each(['https://mzstatic.com.evil.example/art.jpg', 'javascript:alert(1)', 'http://is1-ssl.mzstatic.com/art.jpg'])('rejects unofficial or insecure artwork URLs (%s)', async artworkUrl100 => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([track('Bright Horizon', 'Example Artist', { artworkUrl100 })])));
    expect(await metadata.lookupSongCover('Bright Horizon', 'Example Artist')).toBeNull();
  });

  it('falls back to null for CORS/network failures and permits a later retry', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(catalog([track()]));
    vi.stubGlobal('fetch', fetch);
    expect(await metadata.lookupSongCover('Bright Horizon', 'Example Artist')).toBeNull();
    expect(await metadata.lookupSongCover('Bright Horizon', 'Example Artist')).toBe(highResolutionCoverUrl);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares matching in-flight requests and keeps a successful result in memory', async () => {
    const fetch = vi.fn(async () => catalog([track()]));
    vi.stubGlobal('fetch', fetch);
    const first = metadata.lookupSongCover('Bright Horizon', 'Example Artist');
    const second = metadata.lookupSongCover('Bright Horizon', 'Example Artist');
    expect(await first).toBe(highResolutionCoverUrl);
    expect(await second).toBe(highResolutionCoverUrl);
    expect(await metadata.lookupSongCover('Bright Horizon', 'Example Artist')).toBe(highResolutionCoverUrl);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts after four seconds and never blocks song import on a hanging request', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, _options?: RequestInit) => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetch);
    const pending = metadata.lookupSongCover('Bright Horizon', 'Example Artist');
    await vi.advanceTimersByTimeAsync(4001);
    expect(await pending).toBeNull();
    expect((fetch.mock.calls[0][1] as unknown as RequestInit).signal?.aborted).toBe(true);
  });

  it('does not query blank titles, and tolerates invalid catalog payloads', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ results: null }) }));
    vi.stubGlobal('fetch', fetch);
    expect(await metadata.lookupSongCover('  ')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await metadata.lookupSongCover('Bright Horizon', 'Example Artist')).toBeNull();
  });

  it('upgrades only official Apple catalog thumbnails for high-DPI cards', () => {
    expect(metadata.highResolutionCover(coverUrl)).toBe(highResolutionCoverUrl);
    expect(metadata.highResolutionCover('https://example.com/100x100bb.jpg')).toBe('https://example.com/100x100bb.jpg');
    expect(metadata.highResolutionCover('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
  });

  it('uses embedded art from a replacement audio revision but retains older art otherwise', () => {
    expect(metadata.coverForAudioRevision('https://example.com/old.jpg', 'data:image/png;base64,new'))
      .toBe('data:image/png;base64,new');
    expect(metadata.coverForAudioRevision('data:image/png;base64,old', 'https://example.com/new.jpg'))
      .toBe('data:image/png;base64,old');
  });
});
