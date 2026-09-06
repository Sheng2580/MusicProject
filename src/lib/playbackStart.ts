export class PlaybackStartGate {
  private revision = 0;
  private pending = false;

  get isPending(): boolean {
    return this.pending;
  }

  begin(): number | null {
    if (this.pending) return null;
    this.pending = true;
    return this.revision;
  }

  cancel(): void {
    this.revision++;
    this.pending = false;
  }

  claim(revision: number): boolean {
    if (!this.pending || revision !== this.revision) return false;
    this.pending = false;
    return true;
  }
}

export type GuardedPlaybackStartResult = 'started' | 'cancelled' | 'busy';

export async function runGuardedPlaybackStart(
  gate: PlaybackStartGate,
  unlock: () => Promise<void>,
  start: () => void,
): Promise<GuardedPlaybackStartResult> {
  const revision = gate.begin();
  if (revision === null) return 'busy';
  try {
    await unlock();
  } catch (error) {
    if (!gate.claim(revision)) return 'cancelled';
    throw error;
  }
  if (!gate.claim(revision)) return 'cancelled';
  start();
  return 'started';
}
