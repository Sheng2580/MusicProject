import { describe, expect, it, vi } from 'vitest';
import { PlaybackStartGate, runGuardedPlaybackStart } from '../src/lib/playbackStart';

describe('playback start gate', () => {
  it('does not start an editor audition after navigation cancels its unlock', async () => {
    const gate = new PlaybackStartGate();
    let finishUnlock!: () => void;
    const unlock = new Promise<void>(resolve => { finishUnlock = resolve; });
    const play = vi.fn();
    const completion = runGuardedPlaybackStart(gate, () => unlock, play);

    gate.cancel();
    finishUnlock();

    await expect(completion).resolves.toBe('cancelled');
    expect(play).not.toHaveBeenCalled();
    expect(gate.isPending).toBe(false);
  });

  it('does not let an old completion consume a newer start', () => {
    const gate = new PlaybackStartGate();
    const first = gate.begin();
    gate.cancel();
    const second = gate.begin();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(gate.claim(first!)).toBe(false);
    expect(gate.isPending).toBe(true);
    expect(gate.claim(second!)).toBe(true);
    expect(gate.isPending).toBe(false);
  });

  it('allows one uncancelled start to continue after unlock', async () => {
    const gate = new PlaybackStartGate();
    const play = vi.fn();

    await expect(runGuardedPlaybackStart(gate, async () => undefined, play)).resolves.toBe('started');
    expect(play).toHaveBeenCalledOnce();
  });

  it('reports an active unlock error but ignores one from a cancelled request', async () => {
    const failure = new Error('audio blocked');
    await expect(runGuardedPlaybackStart(new PlaybackStartGate(), async () => { throw failure; }, vi.fn())).rejects.toBe(failure);

    const gate = new PlaybackStartGate();
    let rejectUnlock!: (error: Error) => void;
    const unlock = new Promise<void>((_, reject) => { rejectUnlock = reject; });
    const completion = runGuardedPlaybackStart(gate, () => unlock, vi.fn());
    gate.cancel();
    rejectUnlock(failure);
    await expect(completion).resolves.toBe('cancelled');
  });
});
