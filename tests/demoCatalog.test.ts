import { describe, expect, it } from 'vitest';
import { demoAudioMatches, mergeDemoMelodyUpgrade, readKnownDemoIds, serializeKnownDemoIds, verifyDemoAudio } from '../src/lib/demoCatalog';
import type { MelodyNote, SongAnalysis } from '../src/types';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function savedAudio(contents: BlobPart = 'abc', hash: string | null = ABC_SHA256, verified = true) {
  return {
    fileName: 'demo.mp3',
    audio: new Blob([contents]),
    source: {
      label: 'demo', url: '/demo.mp3', preview: false, version: 'v1', audioSha256: hash ?? undefined,
      audioSha256Verified: verified ? true as const : undefined,
    },
  };
}

const TRACK = { fileName: 'demo.mp3', audioBytes: 3, audioSha256: ABC_SHA256 };

function melody(): MelodyNote[] {
  return Array.from({ length: 8 }, (_, index) => ({
    start: index * .5, duration: .3, midi: 60 + index, confidence: .9, strength: .8,
  }));
}

function analysis(overrides: Partial<SongAnalysis> = {}): SongAnalysis {
  return {
    duration: 4,
    bpm: 160,
    beats: [0, .375, .75, 1.125, 1.5],
    chords: [{ id: 'c', start: 0, end: 4, chord: 'C', confidence: .8 }],
    waveform: [.2, .4],
    key: 'C',
    confidence: .8,
    algorithm: 'legacy analysis',
    ...overrides,
  };
}

describe('incremental demo catalog state', () => {
  it('migrates the old marker without treating a newly added demo as previously deleted', () => {
    const known = readKnownDemoIds(null, true);
    expect(known.has('see-you-again')).toBe(true);
    expect(known.has('xiao-mei-man')).toBe(true);
    expect(known.has('canon-in-d')).toBe(false);
  });

  it('round-trips known IDs deterministically and drops malformed entries', () => {
    const serialized = serializeKnownDemoIds(['xiao-mei-man', 'see-you-again', 'xiao-mei-man']);
    expect(serialized).toBe('["see-you-again","xiao-mei-man"]');
    expect([...readKnownDemoIds('["valid",3,null,""]', false)]).toEqual(['valid']);
  });

  it('falls back to legacy knowledge when stored catalog state is corrupt', () => {
    expect([...readKnownDemoIds('{bad json', true)].sort()).toEqual(['see-you-again', 'xiao-mei-man']);
  });

  it('hashes the downloaded Blob and returns the actual SHA-256 only after it matches the catalog', async () => {
    await expect(verifyDemoAudio(new Blob(['abc']), TRACK)).resolves.toBe(ABC_SHA256);
    await expect(verifyDemoAudio(new Blob(['abd']), TRACK)).rejects.toThrow('完整性校验失败');
    await expect(verifyDemoAudio(new Blob(['ab']), TRACK)).rejects.toThrow('大小不符');
  });

  it('matches a verified cache only after re-hashing its stored audio Blob', async () => {
    await expect(demoAudioMatches(savedAudio('abc', ABC_SHA256.toUpperCase()), {
      ...TRACK, audioSha256: ABC_SHA256.toUpperCase(),
    })).resolves.toBe(true);
    await expect(demoAudioMatches({ ...savedAudio(), fileName: 'renamed.mp3' }, TRACK)).resolves.toBe(false);
    await expect(demoAudioMatches(savedAudio('ab'), TRACK)).resolves.toBe(false);
  });

  it('rejects same-size wrong audio even when its persisted hash claims to match', async () => {
    await expect(demoAudioMatches(savedAudio('abd'), TRACK)).resolves.toBe(false);
  });

  it('forces legacy unverified cache records to rebuild instead of trusting copied catalog data', async () => {
    await expect(demoAudioMatches(savedAudio('abc', ABC_SHA256, false), TRACK)).resolves.toBe(false);
    await expect(demoAudioMatches(savedAudio('abc', null), TRACK)).resolves.toBe(false);
  });

  it('rejects malformed catalog and persisted fingerprints', async () => {
    await expect(demoAudioMatches(savedAudio(), { ...TRACK, audioSha256: 'not-a-sha256' })).resolves.toBe(false);
    await expect(demoAudioMatches(savedAudio('abc', 'bad-saved-hash'), TRACK)).resolves.toBe(false);
    await expect(demoAudioMatches(savedAudio(), { ...TRACK, audioBytes: 3.5 })).resolves.toBe(false);
    await expect(verifyDemoAudio(new Blob(['abc']), { ...TRACK, audioBytes: 0 })).rejects.toThrow('校验信息无效');
  });

  it('calibrates both the automatic baseline and an unedited current analysis to catalog BPM', () => {
    const originalAnalysis = analysis();
    const result = mergeDemoMelodyUpgrade({
      analysis: structuredClone(originalAnalysis),
      originalAnalysis,
    }, melody(), 80);

    expect(result.analysis.bpm).toBe(80);
    expect(result.analysis.beats).toEqual([0, .75, 1.5]);
    expect(result.originalAnalysis.bpm).toBe(80);
    expect(result.originalAnalysis.beats).toEqual([0, .75, 1.5]);
    expect(result.analysis.algorithm).toContain('已校准 80 BPM');
    expect(result.originalAnalysis.algorithm).toContain('已校准 80 BPM');
    expect(result.analysis.melody).toEqual(melody());
  });

  it.each([
    ['BPM', analysis({ bpm: 72 })],
    ['beat positions', analysis({ beats: [.12, .52, .92, 1.32] })],
  ])('preserves manual %s edits while calibrating the new automatic baseline', (_label, current) => {
    const originalAnalysis = analysis();
    const result = mergeDemoMelodyUpgrade({ analysis: current, originalAnalysis }, melody(), 80);

    expect(result.analysis.bpm).toBe(current.bpm);
    expect(result.analysis.beats).toEqual(current.beats);
    expect(result.originalAnalysis.bpm).toBe(80);
    expect(result.originalAnalysis.beats).toEqual([0, .75, 1.5]);
    expect(result.analysis.algorithm).not.toContain('已校准 80 BPM');
    expect(result.analysis.melody).toEqual(melody());
    result.analysis.melody![0].midi = 40;
    expect(result.originalAnalysis.melody![0].midi).toBe(60);
  });
});
