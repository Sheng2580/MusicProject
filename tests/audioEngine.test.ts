import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CHORDS, AudioEngine, CHORD_SHAPES, getChordFrets, getStringMidi, synthesizePercussion, synthesizePluckedString } from '../src/lib/audioEngine';

class Param {
  value = 0;
  setValueAtTime(value: number) { this.value = value; return this; }
  linearRampToValueAtTime(value: number) { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number) { this.value = value; return this; }
  setTargetAtTime(value: number) { this.value = value; return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}

class FakeNode {
  gain = new Param(); frequency = new Param(); Q = new Param(); detune = new Param(); pan = new Param();
  playbackRate = Object.assign(new Param(), { value: 1 });
  threshold = new Param(); knee = new Param(); ratio = new Param(); attack = new Param(); release = new Param();
  buffer: unknown = null;
  type = '';
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  startedAt = 0;
  offset = 0;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  connectedTo: FakeNode | null = null;
  connect(node: FakeNode) { this.connectedTo = node; return node; }
  disconnect() { /* No real audio hardware in unit tests. */ }
  start(time = 0, offset = 0) { this.startedAt = time; this.offset = offset; }
  stop(time = 0) { this.stoppedAt = time; }
}

class FakeContext {
  static latest: FakeContext;
  currentTime = 0;
  sampleRate = 8000;
  state = 'suspended';
  destination = new FakeNode();
  sources: FakeNode[] = [];
  constructor() { FakeContext.latest = this; }
  createGain() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createConvolver() { return new FakeNode(); }
  createStereoPanner() { return new FakeNode(); }
  createOscillator() { return new FakeNode(); }
  createBufferSource() { const node = new FakeNode(); this.sources.push(node); return node; }
  createBuffer(channels: number, length: number, rate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / rate, getChannelData: (channel: number) => data[channel] };
  }
  async decodeAudioData() { return this.createBuffer(1, 80000, 8000); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = '';
  currentTime = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  webkitPreservesPitch = false;
  preload = '';
  loop = false;
  volume = 1;
  muted = false;
  paused = true;
  private listeners = new Map<string, Set<() => void>>();
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  load = vi.fn();

  constructor() { FakeAudio.instances.push(this); }
  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
}

function energy(signal: Float32Array, start: number, length: number, differentiate = false): number {
  let sum = 0;
  for (let i = start; i < Math.min(signal.length, start + length); i++) {
    const sample = signal[i] - (differentiate && i > 0 ? signal[i - 1] : 0);
    sum += sample * sample;
  }
  return sum / length;
}

function measuredFrequency(signal: Float32Array, rate: number, expected: number): number {
  const start = Math.round(rate * 0.12);
  const length = Math.round(rate * 0.08);
  const period = rate / expected;
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = Math.floor(period * 0.96); lag <= Math.ceil(period * 1.04); lag++) {
    let correlation = 0;
    let normA = 0;
    let normB = 0;
    for (let i = start; i < start + length; i++) {
      correlation += signal[i] * signal[i + lag];
      normA += signal[i] ** 2;
      normB += signal[i + lag] ** 2;
    }
    const score = correlation / Math.sqrt(normA * normB);
    if (score > best) { best = score; bestLag = lag; }
  }
  return rate / bestLag;
}

describe('guitar tuning and physical synthesis', () => {
  it('provides every major/minor triad and only plays fretted strings', () => {
    expect(ALL_CHORDS).toHaveLength(25);
    expect(getStringMidi('C', 0)).toBeNull();
    expect(getStringMidi('C', 1)).toBe(48);
    expect(getStringMidi('E', 0)).toBe(40);
    expect(getStringMidi('E', 5)).toBe(64);
    expect(getStringMidi('N', 2)).toBeNull();
    expect(getStringMidi('E', -1)).toBeNull();
    expect(getChordFrets('Bb')).toEqual(CHORD_SHAPES['A#']);
    expect(getChordFrets('F♯m7')).toEqual(CHORD_SHAPES['F#m']);
    expect(getChordFrets('toString')).toEqual(CHORD_SHAPES.N);
    const copy = getChordFrets('E');
    copy[0] = 9;
    expect(CHORD_SHAPES.E[0]).toBe(0);
  });

  it('keeps bass and treble strings in tune and emits finite unclipped samples', () => {
    for (const midi of [40, 64, 76]) {
      const expected = 440 * 2 ** ((midi - 69) / 12);
      const signal = synthesizePluckedString(48000, midi);
      const frequency = measuredFrequency(signal, 48000, expected);
      // Integer autocorrelation resolution is about 12 cents at this treble note.
      expect(Math.abs(1200 * Math.log2(frequency / expected))).toBeLessThan(14);
      expect(signal.every(sample => Number.isFinite(sample) && Math.abs(sample) <= 0.901)).toBe(true);
      expect(signal[0]).toBeCloseTo(0, 8);
      expect(signal[signal.length - 1]).toBeCloseTo(0, 8);
      expect(energy(signal, 48000, 4000)).toBeLessThan(energy(signal, 3000, 4000));
    }
  });

  it('produces a short palm mute and an octave harmonic', () => {
    const normal = synthesizePluckedString(48000, 52, 'pick', 0.8);
    const muted = synthesizePluckedString(48000, 52, 'muted', 0.8);
    const harmonic = synthesizePluckedString(48000, 52, 'harmonic', 0.8);
    expect(muted.length).toBeLessThan(normal.length / 5);
    const expected = 440 * 2 ** ((64 - 69) / 12);
    expect(Math.abs(measuredFrequency(harmonic, 48000, expected) - expected)).toBeLessThan(3);
    expect(energy(muted, 18000, 4000)).toBeLessThan(energy(normal, 18000, 4000));
  });

  it('changes timbre with picking position and attack strength', () => {
    const soft = synthesizePluckedString(48000, 52, 'pick', 0.2, 0.2);
    const hard = synthesizePluckedString(48000, 52, 'pick', 1, 0.2);
    const bridge = synthesizePluckedString(48000, 52, 'pick', 1, 0.9);
    const softBrightness = energy(soft, 4000, 4000, true) / energy(soft, 4000, 4000);
    const hardBrightness = energy(hard, 4000, 4000, true) / energy(hard, 4000, 4000);
    expect(hardBrightness).toBeGreaterThan(softBrightness);
    expect(bridge).not.toEqual(hard);
  });

  it('renders repeatable but distinct excitation variants without changing pitch', () => {
    const first = synthesizePluckedString(48000, 57, 'pick', 0.8, 0.45, 0);
    const repeated = synthesizePluckedString(48000, 57, 'pick', 0.8, 0.45, 0);
    const alternate = synthesizePluckedString(48000, 57, 'pick', 0.8, 0.45, 1);
    const expected = 440 * 2 ** ((57 - 69) / 12);
    expect(repeated).toEqual(first);
    expect(alternate).not.toEqual(first);
    expect(Math.abs(measuredFrequency(first, 48000, expected) - expected)).toBeLessThan(2);
    expect(Math.abs(measuredFrequency(alternate, 48000, expected) - expected)).toBeLessThan(2);
  });
});

describe('audio-clock transport', () => {
  let engine: AudioEngine;
  beforeEach(() => {
    FakeAudio.instances.length = 0;
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('Audio', FakeAudio);
    engine = new AudioEngine();
  });
  afterEach(() => { engine.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('creates its context lazily and freezes at the audio-clock position when paused', async () => {
    await engine.loadSong(new Blob(['test']));
    const clock = FakeContext.latest;
    engine.play(2);
    clock.currentTime = 1.5;
    expect(engine.getCurrentTime()).toBe(3.5);
    engine.pause();
    clock.currentTime = 6;
    expect(engine.getCurrentTime()).toBe(3.5);
    expect(engine.isPlaying()).toBe(false);
    engine.play();
    clock.currentTime = 7;
    expect(engine.getCurrentTime()).toBe(4.5);
  });

  it('keeps seek and natural completion correct without relying on onended delivery', async () => {
    await engine.loadSong(new Blob());
    const clock = FakeContext.latest;
    engine.play();
    clock.currentTime = 2;
    engine.seek(7);
    expect(clock.sources.at(-1)?.offset).toBe(7);
    clock.currentTime = 6;
    expect(engine.getCurrentTime()).toBe(10);
    expect(engine.isPlaying()).toBe(false);
    engine.play();
    expect(engine.getCurrentTime()).toBe(0);
    engine.seek(10);
    expect(engine.getCurrentTime()).toBe(10);
    expect(engine.isPlaying()).toBe(false);
  });

  it('wraps loops at the selected bounds and preserves position when disabling them', async () => {
    await engine.loadSong(new Blob());
    const clock = FakeContext.latest;
    engine.setLoop(2, 5);
    engine.play(1);
    clock.currentTime = 5.5;
    expect(engine.getCurrentTime()).toBe(3.5);
    expect(clock.sources.at(-1)?.loopStart).toBe(2);
    expect(clock.sources.at(-1)?.loopEnd).toBe(5);
    engine.setLoop(0, null);
    expect(engine.getCurrentTime()).toBe(3.5);
    clock.currentTime += 1;
    expect(engine.getCurrentTime()).toBe(4.5);
    engine.setLoop(7, 7);
    expect(clock.sources.at(-1)?.loop).toBe(false);
  });

  it('ignores a stopped source finishing after a new seek starts', async () => {
    await engine.loadSong(new Blob());
    engine.play();
    const old = FakeContext.latest.sources.at(-1)!;
    engine.seek(4);
    old.onended?.();
    expect(engine.isPlaying()).toBe(true);
    expect(engine.getCurrentTime()).toBe(4);
  });

  it.each([0.5, 0.75])('keeps pause/resume in song time at %s practice speed without detuning', async rate => {
    await engine.loadSong(new Blob(), rate);
    const clock = FakeContext.latest;
    engine.play(2);
    expect(clock.sources.at(-1)?.offset).toBe(2 / rate);
    expect(clock.sources.at(-1)?.playbackRate.value).toBe(1);
    clock.currentTime = 1.5;
    expect(engine.getCurrentTime()).toBeCloseTo(2 + 1.5 * rate);
    engine.pause();
    clock.currentTime = 6;
    expect(engine.getCurrentTime()).toBeCloseTo(2 + 1.5 * rate);
    expect(engine.isPlaying()).toBe(false);
    engine.play();
    expect(clock.sources.at(-1)?.offset).toBeCloseTo((2 + 1.5 * rate) / rate);
    expect(clock.sources.at(-1)?.playbackRate.value).toBe(1);
    clock.currentTime = 7;
    expect(engine.getCurrentTime()).toBeCloseTo(2 + 2.5 * rate);
  });

  it.each([0.5, 0.75])('converts seeks and completion to song time at %s practice speed', async rate => {
    await engine.loadSong(new Blob(), rate);
    const clock = FakeContext.latest;
    engine.play();
    clock.currentTime = 2;
    engine.seek(7 * rate);
    expect(clock.sources.at(-1)?.offset).toBe(7);
    clock.currentTime = 4;
    expect(engine.getCurrentTime()).toBe(9 * rate);
    expect(engine.isPlaying()).toBe(true);
    clock.currentTime = 6;
    expect(engine.getCurrentTime()).toBe(10 * rate);
    expect(engine.isPlaying()).toBe(false);
    engine.play();
    expect(engine.getCurrentTime()).toBe(0);
    engine.seek(100);
    expect(engine.getCurrentTime()).toBe(10 * rate);
    expect(engine.isPlaying()).toBe(false);
    engine.play(1);
    clock.sources.at(-1)?.onended?.();
    expect(engine.getCurrentTime()).toBe(10 * rate);
    expect(engine.isPlaying()).toBe(false);
  });

  it.each([0.5, 0.75])('maps loop bounds to the rendered backing at %s practice speed', async rate => {
    await engine.loadSong(new Blob(), rate);
    const clock = FakeContext.latest;
    engine.setLoop(1, 3);
    engine.play(0.5);
    const looped = clock.sources.at(-1)!;
    expect(looped.loopStart).toBe(1 / rate);
    expect(looped.loopEnd).toBe(3 / rate);
    expect(looped.offset).toBe(0.5 / rate);
    clock.currentTime = 4 / rate;
    expect(engine.getCurrentTime()).toBeCloseTo(2.5);
    engine.setLoop(0, null);
    expect(engine.getCurrentTime()).toBeCloseTo(2.5);
    expect(clock.sources.at(-1)?.loop).toBe(false);
    clock.currentTime += 1;
    expect(engine.getCurrentTime()).toBeCloseTo(2.5 + rate);
    engine.setLoop(1, 100);
    expect(clock.sources.at(-1)?.loopEnd).toBe(10);
    engine.setLoop(100, 101);
    expect(clock.sources.at(-1)?.loop).toBe(false);
  });

  it('ignores stale source endings across seeks and rate-changing loads', async () => {
    await engine.loadSong(new Blob(), 0.5);
    const clock = FakeContext.latest;
    engine.play();
    const first = clock.sources.at(-1)!;
    engine.seek(2);
    first.onended?.();
    expect(engine.isPlaying()).toBe(true);
    expect(engine.getCurrentTime()).toBe(2);
    const second = clock.sources.at(-1)!;
    engine.setLoop(1, 3);
    const oldLoop = clock.sources.at(-1)!;
    await engine.loadSong(new Blob());
    expect(engine.isPlaying()).toBe(false);
    expect(engine.getCurrentTime()).toBe(0);
    engine.play(7);
    second.onended?.();
    oldLoop.onended?.();
    expect(engine.isPlaying()).toBe(true);
    expect(engine.getCurrentTime()).toBe(7);
    expect(clock.sources.at(-1)?.offset).toBe(7);
    expect(clock.sources.at(-1)?.loop).toBe(false);
    clock.currentTime = 1;
    expect(engine.getCurrentTime()).toBe(8);
  });

  it('does not let an older asynchronous decode overwrite the latest practice rate', async () => {
    await engine.unlock();
    const clock = FakeContext.latest;
    let finishOld!: (buffer: ReturnType<FakeContext['createBuffer']>) => void;
    const decoding = vi.spyOn(clock, 'decodeAudioData').mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const oldLoad = engine.loadSong(new Blob(), 0.5);
    await vi.waitFor(() => expect(decoding).toHaveBeenCalledTimes(1));
    await engine.loadSong(new Blob(), 0.75);
    finishOld(clock.createBuffer(1, 160000, 8000));
    await oldLoad;
    engine.play(3);
    expect(clock.sources.at(-1)?.offset).toBe(4);
    clock.currentTime = 6;
    expect(engine.getCurrentTime()).toBe(7.5);
    expect(engine.isPlaying()).toBe(false);
  });

  it('blocks playing an old backing while another load is pending', async () => {
    await engine.loadSong(new Blob(), 0.5);
    const clock = FakeContext.latest;
    engine.play();
    const previous = clock.sources.at(-1)!;
    let finish!: (value: ArrayBuffer) => void;
    const nextBlob = new Blob();
    vi.spyOn(nextBlob, 'arrayBuffer').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const loading = engine.loadSong(nextBlob, 0.75);
    engine.play();
    previous.onended?.();
    expect(clock.sources).toHaveLength(1);
    expect(engine.isPlaying()).toBe(false);
    expect(engine.getCurrentTime()).toBe(0);
    finish(new ArrayBuffer(0));
    await loading;
    engine.play(3);
    expect(clock.sources.at(-1)?.offset).toBe(4);
  });

  it.each([[0, 0.5], [2, 1], [Number.NaN, 1], [Infinity, 1]])('bounds practice rate %s to %s', async (input, expected) => {
    await engine.loadSong(new Blob(), input);
    const clock = FakeContext.latest;
    engine.play();
    clock.currentTime = 2;
    expect(engine.getCurrentTime()).toBe(2 * expected);
    expect(clock.sources.at(-1)?.playbackRate.value).toBe(1);
  });

  it('keeps an optional original recording disabled until explicitly enabled and synchronized', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:original');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await engine.loadSong(new Blob(), 0.5, new Blob(['original']));
    const clock = FakeContext.latest;
    const original = FakeAudio.instances[0];
    expect(original).toMatchObject({
      src: 'blob:original', playbackRate: 0.5, defaultPlaybackRate: 0.5,
      preservesPitch: true, webkitPreservesPitch: true, loop: false, muted: true,
    });

    engine.setVolumes({ original: 0.35 });
    expect(original.volume).toBe(0.35);
    engine.play(2);
    expect(clock.sources.at(-1)?.offset).toBe(4);
    expect(original.currentTime).toBe(2);
    expect(original.play).not.toHaveBeenCalled();

    clock.currentTime = 2;
    engine.setOriginalEnabled(true);
    expect(original.currentTime).toBe(3);
    expect(original.muted).toBe(false);
    expect(original.play).toHaveBeenCalledTimes(1);
    expect(original.paused).toBe(false);

    original.currentTime = 0;
    expect(engine.getCurrentTime()).toBe(3);
    expect(original.currentTime).toBe(3);
    engine.seek(4);
    expect(clock.sources.at(-1)?.offset).toBe(8);
    expect(original.currentTime).toBe(4);
    expect(original.paused).toBe(false);
    engine.pause();
    expect(original.paused).toBe(true);
    expect(original.currentTime).toBe(4);
    engine.seek(3);
    expect(original.currentTime).toBe(3);
    expect(original.play).toHaveBeenCalledTimes(1);
    engine.play();
    expect(original.play).toHaveBeenCalledTimes(2);
    engine.setOriginalEnabled(false);
    expect(original.muted).toBe(true);
    expect(original.paused).toBe(true);
  });

  it('keeps original-media time aligned when a segment loop wraps', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:loop');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await engine.loadSong(new Blob(), 0.5, new Blob(['original']));
    const clock = FakeContext.latest;
    const original = FakeAudio.instances[0];
    engine.setOriginalEnabled(true);
    engine.setLoop(1, 3);
    engine.play(0.5);
    expect(original.loop).toBe(false);
    expect(original.currentTime).toBe(0.5);

    clock.currentTime = 5;
    original.currentTime = 3;
    original.emit('timeupdate');
    expect(engine.getCurrentTime()).toBe(1);
    expect(original.currentTime).toBe(1);

    engine.setLoop(0, null);
    clock.currentTime = 6;
    expect(engine.getCurrentTime()).toBe(1.5);
    expect(original.currentTime).toBe(1.5);
  });

  it('detaches original media and revokes object URLs on reload and disposal', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await engine.loadSong(new Blob());
    expect(FakeAudio.instances).toHaveLength(0);

    await engine.loadSong(new Blob(), 1, new Blob(['first']));
    const first = FakeAudio.instances[0];
    expect(first.src).toBe('blob:first');
    await engine.loadSong(new Blob(), 0.75, new Blob(['second']));
    const second = FakeAudio.instances[1];
    expect(first.src).toBe('');
    expect(first.pause).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalledWith('blob:first');
    expect(second.src).toBe('blob:second');

    engine.dispose();
    expect(second.src).toBe('');
    expect(second.pause).toHaveBeenCalled();
    expect(createUrl).toHaveBeenCalledTimes(2);
    expect(revokeUrl.mock.calls).toEqual([['blob:first'], ['blob:second']]);
  });

  it('does not sound muted strings and damps ringing guitar independently of the song', async () => {
    await engine.loadSong(new Blob());
    await engine.unlock();
    engine.play();
    const clock = FakeContext.latest;
    const song = clock.sources[0];
    engine.pluckString('C', 0);
    expect(clock.sources).toHaveLength(1);
    engine.pluckString('C', 1, 0.8);
    const guitar = clock.sources.at(-1)!;
    engine.muteStrings();
    expect(guitar.stoppedAt).toBeLessThan(0.05);
    expect(song.stoppedAt).toBeNull();
    expect(engine.isPlaying()).toBe(true);
    engine.dispose();
    expect(clock.state).toBe('closed');
  });

  it('unlocks before deferred guitar samples finish and upgrades later plucks when they arrive', async () => {
    vi.stubGlobal('location', { href: 'http://127.0.0.1/' });
    let releaseSamples!: () => void;
    const sampleGate = new Promise<void>(resolve => { releaseSamples = resolve; });
    const fetchAudio = vi.fn(async () => {
      await sampleGate;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    });
    const decodeAudio = vi.spyOn(FakeContext.prototype, 'decodeAudioData');
    vi.stubGlobal('fetch', fetchAudio);

    await engine.unlock();
    const clock = FakeContext.latest;
    expect(clock.state).toBe('running');
    expect(fetchAudio).toHaveBeenCalled();

    engine.pluckMidi(61, 0.8, 0.2);
    const synthesized = clock.sources.at(-1)!;
    expect(synthesized.playbackRate.value).toBe(1);

    releaseSamples();
    await vi.waitFor(() => expect(decodeAudio).toHaveBeenCalledTimes(fetchAudio.mock.calls.length));
    await Promise.resolve();
    engine.pluckMidi(61, 0.8, 0.2);
    expect(clock.sources.at(-1)?.playbackRate.value).toBeCloseTo(2 ** (1 / 12), 6);
  });

  it('does not lose dense plucks while the shared sample load remains pending', async () => {
    vi.stubGlobal('location', { href: 'http://127.0.0.1/' });
    let releaseSamples!: () => void;
    const sampleGate = new Promise<void>(resolve => { releaseSamples = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await sampleGate;
      return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    }));

    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      engine.unlock().then(() => engine.pluckMidi(60 + index % 4, 0.8, 0.12))
    )));
    const clock = FakeContext.latest;
    expect(clock.sources).toHaveLength(12);
    expect(clock.sources.every(source => source.buffer && source.playbackRate.value === 1)).toBe(true);
    releaseSamples();
  });

  it('rejects unlock when resume fails and does not start sample downloads prematurely', async () => {
    await engine.loadSong(new Blob());
    const clock = FakeContext.latest;
    const resumeError = new Error('Audio permission denied');
    vi.spyOn(clock, 'resume').mockRejectedValueOnce(resumeError);
    vi.stubGlobal('location', { href: 'http://127.0.0.1/' });
    const fetchAudio = vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }));
    vi.stubGlobal('fetch', fetchAudio);

    await expect(engine.unlock()).rejects.toBe(resumeError);
    expect(clock.state).toBe('suspended');
    expect(fetchAudio).not.toHaveBeenCalled();

    await engine.unlock();
    expect(clock.state).toBe('running');
    expect(fetchAudio).toHaveBeenCalled();
  });

  it('plays score MIDI at its written pitch with a deterministic four-voice cycle', async () => {
    await engine.unlock();
    const clock = FakeContext.latest;
    engine.setTechnique('harmonic');
    engine.pluckMidi(NaN);
    engine.pluckMidi(23);
    engine.pluckMidi(109);
    engine.pluckMidi(69, 0);
    expect(clock.sources).toHaveLength(0);

    for (let index = 0; index < 5; index++) engine.pluckMidi(69, 0.8);
    expect(clock.sources).toHaveLength(5);
    expect(clock.sources.slice(0, 4).map(source => source.buffer).every((buffer, index, all) => index === 0 || buffer !== all[index - 1])).toBe(true);
    expect(clock.sources[4].buffer).toBe(clock.sources[0].buffer);
    expect(clock.sources.map(source => source.detune.value)).toEqual([-0.45, 0.3, -0.15, 0.5, -0.45]);
    const signal = (clock.sources[0].buffer as { getChannelData(channel: number): Float32Array }).getChannelData(0);
    expect(Math.abs(measuredFrequency(signal, clock.sampleRate, 440) - 440)).toBeLessThan(10);
  });

  it('uses the bundled guitar samples and pitch-shifts only the missing accidental', async () => {
    vi.stubGlobal('location', { href: 'http://127.0.0.1/' });
    const fetchAudio = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    vi.stubGlobal('fetch', fetchAudio);
    await engine.unlock();
    const clock = FakeContext.latest;

    await vi.waitFor(() => expect(fetchAudio).toHaveBeenCalledTimes(28));
    await Promise.resolve();

    engine.pluckMidi(61, 0.8, 0.2);
    const source = clock.sources.at(-1)!;

    expect(fetchAudio).toHaveBeenCalled();
    expect(source.playbackRate.value).toBeCloseTo(2 ** (1 / 12), 6);
    expect(source.stoppedAt).toBeCloseTo(0.35, 6);
  });

  it('keeps a score melody monophonic across strings and follows note duration', async () => {
    await engine.unlock();
    const clock = FakeContext.latest;
    engine.pluckMidi(60, 0.8, 0.2);
    const first = clock.sources.at(-1)!;
    engine.pluckMidi(72, 0.8, 0.45);
    const second = clock.sources.at(-1)!;

    expect(first.stoppedAt).toBeLessThan(0.03);
    expect(second.stoppedAt).toBeCloseTo(0.6, 6);
  });

  it('can sound an open string when the current chord marks that lane muted', async () => {
    await engine.unlock();
    const clock = FakeContext.latest;
    engine.pluckOpenString(0, 0.8);
    expect(clock.sources).toHaveLength(1);
    engine.pluckOpenString(-1, 0.8);
    engine.pluckOpenString(6, 0.8);
    expect(clock.sources).toHaveLength(1);
  });

  it('caches percussion, routes it through rhythm volume, and stops it on disposal', async () => {
    await engine.unlock();
    const clock = FakeContext.latest;
    engine.setVolumes({ metronome: 0.3 });
    engine.drum(true);
    engine.drum(false);
    engine.drum(true);
    expect(clock.sources[0].buffer).toBe(clock.sources[2].buffer);
    expect(clock.sources[0].buffer).not.toBe(clock.sources[1].buffer);
    expect(clock.sources[0].connectedTo?.gain.value).toBe(0.3);
    const stopAt = clock.sources[0].stoppedAt;
    engine.muteStrings();
    expect(clock.sources[0].stoppedAt).toBe(stopAt);
    engine.setVolumes({ metronome: 0 });
    engine.drum();
    expect(clock.sources).toHaveLength(3);
    expect(clock.sources[0].connectedTo?.gain.value).toBe(0);
    engine.dispose();
    expect(clock.sources.every(source => source.stoppedAt === 0)).toBe(true);
  });
});

describe('restrained percussion synthesis', () => {
  it('provides a stronger low accent, bounded output and smooth silent ends', () => {
    const accent = synthesizePercussion(48000, true);
    const ordinary = synthesizePercussion(48000, false);
    for (const samples of [accent, ordinary]) {
      expect(samples.every(sample => Number.isFinite(sample) && Math.abs(sample) < 0.65)).toBe(true);
      expect(samples[0]).toBeCloseTo(0, 8);
      expect(samples[samples.length - 1]).toBeCloseTo(0, 8);
      expect(energy(samples, 7000, 1500)).toBeLessThan(energy(samples, 1000, 1500));
    }
    expect(energy(accent, 1000, 3000)).toBeGreaterThan(energy(ordinary, 1000, 3000) * 2);
  });
});
