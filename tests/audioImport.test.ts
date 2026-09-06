import { describe, expect, it } from 'vitest';
import { isMp3FileName, MP3_FILE_ACCEPT } from '../src/lib/audioImport';

describe('player audio import', () => {
  it('accepts MP3 filenames regardless of extension case', () => {
    expect(isMp3FileName('song.mp3')).toBe(true);
    expect(isMp3FileName('SONG.MP3')).toBe(true);
    expect(MP3_FILE_ACCEPT).toContain('.mp3');
  });

  it.each(['song.wav', 'song.m4a', 'score.mid', 'score.musicxml', 'analysis.json', 'song.mp3.exe'])('rejects non-MP3 input %s', fileName => {
    expect(isMp3FileName(fileName)).toBe(false);
  });
});
