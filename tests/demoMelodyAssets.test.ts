import { describe, expect, it } from 'vitest';
import seeYouAgainMelody from '../public/demo/see-you-again-melody.json';
import tracks from '../public/demo/tracks.json';
import xiaoMeiManMelody from '../public/demo/xiao-mei-man-melody.json';

interface AssetNote {
  start: number;
  duration: number;
  midi: number;
  confidence: number;
  strength: number;
}

const EXPECTED = {
  'see-you-again': {
    notes: seeYouAgainMelody,
    count: 558,
    duration: 229.564082,
    sha256: '3106b4222cf667a9cc87b9052c5069c8a84af7ddb5ad7f08f3379ddfedaf3502',
    version: 'full-mp3-v9-game103-melody-3106b422-tempo80',
  },
  'xiao-mei-man': {
    notes: xiaoMeiManMelody,
    count: 452,
    duration: 214.248,
    sha256: 'c077b861be314a101509f97a52567aec45c56140b9c9388e345ccde2ee3d7100',
    version: 'full-mp3-v8-game103-melody-c077b861-tempo76',
  },
} satisfies Record<string, {
  notes: AssetNote[];
  count: number;
  duration: number;
  sha256: string;
  version: string;
}>;

function maximumSilentGap(notes: AssetNote[]): number {
  return Math.max(...notes.slice(1).map((note, index) => (
    note.start - (notes[index].start + notes[index].duration)
  )));
}

async function canonicalSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('packaged demo melody assets', () => {
  it.each(Object.entries(EXPECTED))('%s is a complete, ordered monophonic event list', (_id, asset) => {
    expect(asset.notes).toHaveLength(asset.count);
    for (const [index, note] of asset.notes.entries()) {
      expect(Object.keys(note).sort()).toEqual(['confidence', 'duration', 'midi', 'start', 'strength']);
      expect(Number.isFinite(note.start) && note.start >= 0).toBe(true);
      expect(Number.isFinite(note.duration) && note.duration >= .045).toBe(true);
      expect(note.start + note.duration).toBeLessThanOrEqual(asset.duration);
      expect(Number.isInteger(note.midi) && note.midi >= 24 && note.midi <= 108).toBe(true);
      expect(note.confidence).toBeGreaterThanOrEqual(0);
      expect(note.confidence).toBeLessThanOrEqual(1);
      expect(note.strength).toBeGreaterThanOrEqual(0);
      expect(note.strength).toBeLessThanOrEqual(1);
      if (index > 0) {
        expect(note.start).toBeGreaterThan(asset.notes[index - 1].start);
        expect(note.start + 1e-9).toBeGreaterThanOrEqual(
          asset.notes[index - 1].start + asset.notes[index - 1].duration,
        );
      }
    }
  });

  it('uses GAME note boundaries and corrected pitches at the first See You Again vocal entrance', () => {
    expect(seeYouAgainMelody.filter(note => note.start >= 11 && note.start < 12.2).slice(0, 4)).toEqual([
      expect.objectContaining({ start: 11.01, midi: 58 }),
      expect.objectContaining({ start: 11.41, midi: 62 }),
      expect.objectContaining({ start: 11.76, midi: 65 }),
      expect.objectContaining({ start: 12.14, midi: 67 }),
    ]);
  });

  it('keeps the Xiao Mei Man instrumental bridge and does not leave a long chart hole', () => {
    const bridge = xiaoMeiManMelody.filter(note => note.start >= 90 && note.start < 99);
    expect(bridge.length).toBeGreaterThanOrEqual(15);
    expect(bridge[0]).toMatchObject({ start: 90.15, midi: 82 });
    expect(bridge).toContainEqual(expect.objectContaining({ start: 97.726, midi: 65 }));
    expect(maximumSilentGap(xiaoMeiManMelody)).toBeLessThan(3);
  });

  it('keeps catalog versions tied to the expected melody asset digests', async () => {
    for (const [id, asset] of Object.entries(EXPECTED)) {
      expect(await canonicalSha256(asset.notes)).toBe(asset.sha256);
      const track = tracks.find(candidate => candidate.id === id);
      expect(track?.version).toBe(asset.version);
      expect(track?.version).toContain(`melody-${asset.sha256.slice(0, 8)}`);
    }
  });
});
