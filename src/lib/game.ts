import type { ChordSegment, PlayMode } from '../types';

export function isHighMatch(total: number, accuracy: number, playing: boolean, mode: PlayMode): boolean {
  return Number.isFinite(total) && Number.isFinite(accuracy) && playing && mode !== 'free' && total >= 6 && accuracy >= 85;
}

export function timingGrade(difference: number): 'perfect' | 'good' | 'miss' {
  if (!Number.isFinite(difference)) return 'miss';
  const distance = Math.abs(difference);
  return distance <= 0.08 ? 'perfect' : distance <= 0.18 ? 'good' : 'miss';
}

export function chordAt(chords: ChordSegment[], time: number): ChordSegment | undefined {
  return chords.find(chord => time >= chord.start && time < chord.end) ?? (time === 0 ? chords[0] : undefined);
}

export function nearestBeat(beats: number[], time: number): { index: number; difference: number } | null {
  if (!beats.length) return null;
  let low = 0;
  let high = beats.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (beats[mid] < time) low = mid + 1;
    else high = mid;
  }
  const index = low > 0 && Math.abs(beats[low - 1] - time) < Math.abs(beats[low] - time) ? low - 1 : low;
  return { index, difference: time - beats[index] };
}

export function formatTime(time: number): string {
  const seconds = Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function validateBoundaries(chord: ChordSegment, start: number, end: number, duration: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= duration + 0.001 && end - start >= 0.1 && Boolean(chord.id);
}

export function replaceChordBoundary(chords: ChordSegment[], index: number, start: number, end: number): ChordSegment[] {
  return chords.map((segment, i) => {
    if (i === index) return { ...segment, start, end, edited: true };
    if (i === index - 1) return { ...segment, end: start, edited: true };
    if (i === index + 1) return { ...segment, start: end, edited: true };
    return segment;
  });
}
