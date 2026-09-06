export interface SongMetadata {
  title: string;
  artist?: string;
  cover?: string;
}

export function isEmbeddedCover(value: string | undefined): boolean {
  return typeof value === 'string'
    && /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(value);
}

/** Prefer artwork carried by the replacement audio over stale saved artwork. */
export function coverForAudioRevision(previous: string | undefined, replacement: string | undefined): string | undefined {
  return isEmbeddedCover(replacement) ? replacement : previous ?? replacement;
}

interface CatalogTrack {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  kind?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
}

interface KnownRecording {
  id: number;
  country: string;
  titles: string[];
  artist: string;
}

const MAX_COVER_BYTES = 8 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 4000;
const CATALOG_COVER_SIZE = 1000;
const coverRequests = new Map<string, Promise<string | null>>();

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined;
}

function normalize(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
}

function titleKey(value: string): string {
  return normalize(value
    .replace(/[([]\s*(?:feat(?:uring)?|ft)\.?\s+[^)\]]*[)\]]/gi, '')
    .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+.+$/i, ''));
}

function artistKey(value: string): string {
  const primary = normalize(value.replace(/\s+(?:\(|\[)?\s*(?:feat(?:uring)?|ft)\.?\s+.+$/i, ''));
  if (primary === 'zhoushen' || primary === '周深') return '周深';
  if (primary === 'wizkhalifacharlieputh') return 'wizkhalifa';
  return primary;
}

// These IDs were checked against Apple's public catalog on 2026-09-05.
const knownRecordings: KnownRecording[] = [
  { id: 966411602, country: 'us', titles: ['See You Again'], artist: 'Wiz Khalifa' },
  {
    id: 1733140195,
    country: 'tw',
    titles: [
      '小美满', '小美滿', 'Little Joys',
      '小美满 (电影《热辣滚烫》热辣陪伴曲)',
      '小美滿 (電影《熱辣滾燙》熱辣陪伴曲)',
      'Little Joys (Interlude Song from Motion Picture "Yolo")',
    ],
    artist: '周深',
  },
];

function filenameMetadata(fileName: string): SongMetadata {
  const name = fileName.split(/[\\/]/).at(-1) ?? '';
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/^\d{1,2}[.)]\s+/, '').trim();
  const pair = /^(.+?)\s+[-–—]\s+(.+)$/.exec(stem);
  return pair
    ? { title: cleanText(pair[2]) ?? '未命名曲目', artist: cleanText(pair[1]) }
    : { title: cleanText(stem) ?? '未命名曲目' };
}

function embeddedCover(data: Uint8Array, format: string): string | undefined {
  const mime = format.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) || !data.length || data.length > MAX_COVER_BYTES) return undefined;
  const pieces: string[] = [];
  for (let offset = 0; offset < data.length; offset += 8192) {
    pieces.push(String.fromCharCode(...data.subarray(offset, offset + 8192)));
  }
  return `data:${mime};base64,${btoa(pieces.join(''))}`;
}

interface EmbeddedPicture {
  format: string;
  data: Uint8Array;
  type?: string;
  name?: string;
  description?: string;
}

function isFrontCoverLabel(value: string | undefined): boolean {
  const label = value?.trim().toLowerCase();
  return label === 'cover (front)' || label === 'front cover' || label === 'cover front'
    || label === 'front' || label === 'cover';
}

function isFrontCover(picture: EmbeddedPicture): boolean {
  // An explicit APIC/FLAC picture type is authoritative. A generic
  // description such as "cover" must not promote a declared back cover.
  if (picture.type?.trim()) return isFrontCoverLabel(picture.type);
  return isFrontCoverLabel(picture.name) || isFrontCoverLabel(picture.description);
}

function selectEmbeddedCover(pictures: EmbeddedPicture[] | undefined): string | undefined {
  if (!pictures?.length) return undefined;
  const preferred = pictures.filter(isFrontCover);
  const remaining = pictures.filter(picture => !isFrontCover(picture));
  for (const picture of [...preferred, ...remaining]) {
    const cover = embeddedCover(picture.data, picture.format);
    if (cover) return cover;
  }
  return undefined;
}

/** Read tags and embedded art locally; this function never makes a network request. */
export async function readSongMetadata(blob: Blob, fileName: string): Promise<SongMetadata> {
  const fallback = filenameMetadata(fileName);
  try {
    const { parseBlob } = await import('music-metadata');
    const { common } = await parseBlob(blob, { duration: false, skipCovers: false });
    return {
      title: cleanText(common.title) ?? fallback.title,
      artist: cleanText(common.artist) ?? cleanText(common.albumartist) ?? fallback.artist,
      cover: selectEmbeddedCover(common.picture),
    };
  } catch {
    // Missing or malformed tags should never prevent audio import.
    return fallback;
  }
}

function isOfficialArtworkUrl(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname.endsWith('.mzstatic.com') || url.hostname.endsWith('.itunes.apple.com'));
}

/** Upgrade Apple's catalog thumbnail while leaving embedded and third-party art unchanged. */
export function highResolutionCover(value: string): string {
  try {
    const url = new URL(value);
    if (!isOfficialArtworkUrl(url)) return value;
    url.pathname = url.pathname.replace(
      /\/\d+x\d+([a-z]*)\.([a-z0-9]+)$/i,
      `/${CATALOG_COVER_SIZE}x${CATALOG_COVER_SIZE}$1.$2`,
    );
    return url.href;
  } catch {
    return value;
  }
}

function artwork(track: CatalogTrack): string | null {
  const value = track.artworkUrl100 ?? track.artworkUrl60;
  if (!value) return null;
  try {
    const url = new URL(value);
    return isOfficialArtworkUrl(url) ? highResolutionCover(url.href) : null;
  } catch {
    return null;
  }
}

async function queryCover(title: string, artist: string | undefined, signal: AbortSignal): Promise<string | null> {
  const requestedTitle = titleKey(title);
  const requestedArtist = artist ? artistKey(artist) : undefined;
  // A title alone is not enough to bind an ambiguous name to a preset artist.
  const known = requestedArtist ? knownRecordings.find(recording => recording.titles.some(alias => titleKey(alias) === requestedTitle)
    && artistKey(recording.artist) === requestedArtist) : undefined;
  const url = new URL(known ? 'https://itunes.apple.com/lookup' : 'https://itunes.apple.com/search');
  if (known) {
    url.searchParams.set('id', String(known.id));
    url.searchParams.set('country', known.country);
  } else {
    url.searchParams.set('term', [title, artist].filter(Boolean).join(' '));
    url.searchParams.set('entity', 'song');
    url.searchParams.set('country', 'us');
    url.searchParams.set('limit', '25');
  }
  const response = await fetch(url.href, { signal, credentials: 'omit' });
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || !('results' in payload) || !Array.isArray(payload.results)) return null;
  const matches = (payload.results as CatalogTrack[]).filter(track => {
    if (!track || typeof track !== 'object' || typeof track.trackName !== 'string' || typeof track.artistName !== 'string') return false;
    if (track.kind && track.kind !== 'song') return false;
    const sameTitle = known
      ? track.trackId === known.id && known.titles.some(alias => titleKey(alias) === titleKey(track.trackName!))
      : titleKey(track.trackName) === requestedTitle;
    return sameTitle && (!requestedArtist || artistKey(track.artistName) === requestedArtist);
  });
  // Without an artist tag, multiple performers with the same title are ambiguous.
  if (!requestedArtist && new Set(matches.map(track => artistKey(track.artistName!))).size !== 1) return null;
  return matches.map(artwork).find((cover): cover is string => Boolean(cover)) ?? null;
}

/**
 * Match official catalog artwork using only song title and artist text.
 * Audio stays local. Offline, CORS, timeout and nonmatching results return null.
 */
export function lookupSongCover(title: string, artist?: string): Promise<string | null> {
  const songTitle = cleanText(title);
  const songArtist = cleanText(artist);
  if (!songTitle || !titleKey(songTitle)) return Promise.resolve(null);
  const key = `${titleKey(songTitle)}\u0000${songArtist ? artistKey(songArtist) : ''}`;
  const cached = coverRequests.get(key);
  if (cached) return cached;

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<null>(resolve => {
    timeout = setTimeout(() => { controller.abort(); resolve(null); }, LOOKUP_TIMEOUT_MS);
  });
  const request = Promise.race([queryCover(songTitle, songArtist, controller.signal).catch(() => null), deadline])
    .finally(() => clearTimeout(timeout))
    .then(cover => {
      if (!cover) coverRequests.delete(key);
      return cover;
    });
  if (coverRequests.size >= 100) coverRequests.delete(coverRequests.keys().next().value!);
  coverRequests.set(key, request);
  return request;
}
