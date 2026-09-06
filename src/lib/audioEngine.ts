import type { StrumDirection } from '../types';

export type GuitarTechnique = 'pick' | 'finger' | 'muted' | 'harmonic';

/** Standard tuning, from the bass string to the treble string. -1 is muted. */
export const CHORD_SHAPES: Record<string, number[]> = {
  C: [-1, 3, 2, 0, 1, 0], Cm: [-1, 3, 5, 5, 4, 3],
  'C#': [-1, 4, 6, 6, 6, 4], 'C#m': [-1, 4, 6, 6, 5, 4],
  D: [-1, -1, 0, 2, 3, 2], Dm: [-1, -1, 0, 2, 3, 1],
  'D#': [-1, 6, 8, 8, 8, 6], 'D#m': [-1, 6, 8, 8, 7, 6],
  E: [0, 2, 2, 1, 0, 0], Em: [0, 2, 2, 0, 0, 0],
  F: [1, 3, 3, 2, 1, 1], Fm: [1, 3, 3, 1, 1, 1],
  'F#': [2, 4, 4, 3, 2, 2], 'F#m': [2, 4, 4, 2, 2, 2],
  G: [3, 2, 0, 0, 0, 3], Gm: [3, 5, 5, 3, 3, 3],
  'G#': [4, 6, 6, 5, 4, 4], 'G#m': [4, 6, 6, 4, 4, 4],
  A: [-1, 0, 2, 2, 2, 0], Am: [-1, 0, 2, 2, 1, 0],
  'A#': [-1, 1, 3, 3, 3, 1], 'A#m': [-1, 1, 3, 3, 2, 1],
  B: [-1, 2, 4, 4, 4, 2], Bm: [-1, 2, 4, 4, 3, 2],
  N: [-1, -1, -1, -1, -1, -1],
};

export const ALL_CHORDS = Object.keys(CHORD_SHAPES);
export const OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64] as const;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const VOICE_VARIANTS = 4;
const VOICE_DETUNE = [-0.45, 0.3, -0.15, 0.5] as const;
const MAX_VOICE_CACHE = 96;
const GUITAR_SAMPLE_MIDIS = [
  40, 41, 43, 45, 47, 48, 50, 52, 53, 55, 57, 59, 60,
  62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86,
] as const;

export function getChordFrets(chord: string): number[] {
  const normalized = chord.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (Object.hasOwn(CHORD_SHAPES, normalized)) return [...CHORD_SHAPES[normalized]];
  const match = /^([A-G])([#b]?)(m|min|maj)?(?:7|6|9|11|13|sus2|sus4|add9)?(?:\/[A-G][#b]?)?$/i.exec(normalized);
  if (!match) return [...CHORD_SHAPES.N];
  const root = (ROOTS[match[1].toUpperCase()] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + 12) % 12;
  const minor = match[3]?.toLowerCase() === 'm' || match[3]?.toLowerCase() === 'min';
  // Extended and slash chords use their major/minor triad for the six-string voicing.
  return [...CHORD_SHAPES[`${NOTE_NAMES[root]}${minor ? 'm' : ''}`]];
}

export function getStringMidi(chord: string, stringIndex: number): number | null {
  if (!Number.isInteger(stringIndex) || stringIndex < 0 || stringIndex > 5) return null;
  const fret = getChordFrets(chord)[stringIndex];
  return fret < 0 ? null : OPEN_STRING_MIDI[stringIndex] + fret;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finiteOr = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;

function renderPluckedString(
  sampleRate: number,
  midi: number,
  technique: GuitarTechnique = 'pick',
  velocity = 0.75,
  pickPosition = 0.5,
  variation = 0,
  harmonicOctave = true,
): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Invalid sample rate');
  if (!Number.isFinite(midi) || midi < 24 || midi > 108) throw new RangeError('Invalid MIDI note');
  const strength = clamp(finiteOr(velocity, 0.75), 0.05, 1);
  const playedMidi = midi + (technique === 'harmonic' && harmonicOctave ? 12 : 0);
  const frequency = 440 * 2 ** ((playedMidi - 69) / 12);
  const decay = technique === 'muted' ? 0.23 + strength * 0.15
    : (technique === 'harmonic' ? 4 : technique === 'finger' ? 3.8 : 4.6) * (1.1 - (midi - 40) * 0.009) * (0.75 + 0.25 * strength);
  const duration = clamp(decay + 0.22, 0.4, 5.6);
  const output = new Float32Array(Math.ceil(sampleRate * duration));
  // Account for the low-pass filter's phase delay so fret pitches stay in tune.
  const damping = technique === 'finger' ? 0.59 : technique === 'muted' ? 0.65 : technique === 'harmonic' ? 0.4 : 0.36 + (1 - strength) * 0.18;
  const delay = Math.max(4, sampleRate / frequency - damping / (1 - damping));
  const wholeDelay = Math.floor(delay);
  const fraction = delay - wholeDelay;
  const period = wholeDelay + 2;
  const noise = new Float32Array(period);
  const voiceVariation = Number.isFinite(variation) ? Math.trunc(variation) : 0;
  let seed = (Math.round(midi * 743 + strength * 1399 + pickPosition * 523) + Math.imul(voiceVariation, 104729)) | 0;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296 * 2 - 1;
  };
  for (let i = 0; i < period; i++) noise[i] = random();
  const notch = Math.max(1, Math.floor(period * (0.08 + clamp(finiteOr(pickPosition, 0.5), 0, 1) * 0.34)));
  let mean = 0;
  for (let i = 0; i < period; i++) {
    const excitation = noise[i] - noise[(i + notch) % period] * 0.76;
    output[i] = excitation;
    mean += excitation / period;
  }
  for (let i = 0; i < period; i++) output[i] -= mean;
  const loss = Math.exp(Math.log(0.001) / (frequency * decay));
  let lastFiltered = output[period - 1];
  for (let i = period; i < output.length; i++) {
    const delayed = output[i - wholeDelay] * (1 - fraction) + output[i - wholeDelay - 1] * fraction;
    lastFiltered = ((1 - damping) * delayed + damping * lastFiltered) * loss;
    output[i] = lastFiltered;
  }
  // Normalize initial energy, then use a smooth attack and tail; dynamics remain in the voice gain.
  let energy = 0;
  let peak = 0;
  const energyLength = Math.min(output.length, Math.floor(sampleRate * 0.075));
  for (let i = 0; i < output.length; i++) {
    peak = Math.max(peak, Math.abs(output[i]));
    if (i < energyLength) energy += output[i] * output[i];
  }
  const scale = Math.min(0.9 / Math.max(peak, 0.001), 0.21 / Math.max(Math.sqrt(energy / energyLength), 0.001));
  const attack = sampleRate * (technique === 'finger' ? 0.0024 : 0.0007);
  const tail = Math.min(sampleRate * 0.08, output.length / 4);
  for (let i = 0; i < output.length; i++) {
    output[i] *= scale * Math.min(1, i / attack) * Math.min(1, (output.length - 1 - i) / tail);
  }
  return output;
}

/** Fractional-delay Karplus–Strong string, rendered without an AudioContext. */
export function synthesizePluckedString(
  sampleRate: number,
  midi: number,
  technique: GuitarTechnique = 'pick',
  velocity = 0.75,
  pickPosition = 0.5,
  variation = 0,
): Float32Array {
  return renderPluckedString(sampleRate, midi, technique, velocity, pickPosition, variation);
}

/** A quiet acoustic-style kick, closed hat and rim/clap; deterministic so both beat types can be cached. */
export function synthesizePercussion(sampleRate: number, accent = false): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Invalid sample rate');
  const duration = accent ? 0.48 : 0.28;
  const samples = new Float32Array(Math.ceil(sampleRate * duration));
  let phase = 0;
  let seed = accent ? 47291 : 93821;
  let previousNoise = 0;
  let fastNoise = 0;
  let slowNoise = 0;
  const fastCoefficient = 1 - Math.exp(-2 * Math.PI * 3400 / sampleRate);
  const slowCoefficient = 1 - Math.exp(-2 * Math.PI * 900 / sampleRate);
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const noise = (seed >>> 0) / 4294967296 * 2 - 1;
    const highNoise = (noise - previousNoise) * 0.5;
    previousNoise = noise;
    fastNoise += fastCoefficient * (noise - fastNoise);
    slowNoise += slowCoefficient * (noise - slowNoise);
    const pitch = (accent ? 49 : 60) + (accent ? 113 : 85) * Math.exp(-t / 0.024);
    phase += 2 * Math.PI * pitch / sampleRate;
    const kick = Math.sin(phase) * (accent ? 0.42 : 0.22) * Math.exp(-t / (accent ? 0.093 : 0.062));
    const hat = highNoise * (accent ? 0.04 : 0.045) * Math.exp(-t / 0.019);
    const clapEnvelope = Math.exp(-t / 0.005)
      + (t >= 0.012 ? Math.exp(-(t - 0.012) / 0.006) : 0)
      + (t >= 0.025 ? Math.exp(-(t - 0.025) / 0.025) : 0);
    const clap = accent ? 0 : (fastNoise - slowNoise) * clapEnvelope * 0.055;
    const rim = accent ? 0 : (Math.sin(2 * Math.PI * 1470 * t) + Math.sin(2 * Math.PI * 2130 * t)) * 0.015 * Math.exp(-t / 0.012);
    const attack = Math.min(1, t / 0.0008);
    const tail = Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.025));
    samples[i] = (kick + hat + clap + rim) * attack * tail;
  }
  return samples;
}

type Voice = { source: AudioBufferSourceNode; envelope: GainNode; filter: BiquadFilterNode; pan: StereoPannerNode; stringIndex: number; scoreNote: boolean };
type PitchPreservingAudioElement = HTMLAudioElement & { webkitPreservesPitch?: boolean };

export class AudioEngine {
  private context: AudioContext | null = null;
  private songBus: GainNode | null = null;
  private guitarBus: GainNode | null = null;
  private metronomeBus: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private songSource: AudioBufferSourceNode | null = null;
  private songEnvelope: GainNode | null = null;
  private originalAudio: PitchPreservingAudioElement | null = null;
  private originalUrl: string | null = null;
  private originalEnabled = false;
  private volumes = { song: 0.7, original: 0.7, guitar: 0.8, metronome: 0.35 };
  private position = 0;
  private startedAt = 0;
  // The backing is rendered at the practice tempo, so its samples play at native
  // pitch while transport positions remain in the original song's seconds.
  private timelineRate = 1;
  private playing = false;
  private disposed = false;
  private loadRevision = 0;
  private loopStart = 0;
  private loopEnd: number | null = null;
  private technique: GuitarTechnique = 'pick';
  private pickPosition = 0.5;
  private voices = new Set<Voice>();
  private strings = new Map<number, Voice>();
  private clicks = new Set<OscillatorNode>();
  private drums = new Set<AudioBufferSourceNode>();
  private drumBuffers = new Map<boolean, AudioBuffer>();
  private voiceCache = new Map<string, AudioBuffer>();
  private voiceSequences = new Map<string, number>();
  private guitarSamples = new Map<number, AudioBuffer>();
  private guitarSampleLoad: Promise<void> | null = null;
  private readonly onOriginalMetadata = () => {
    this.syncOriginal(this.currentTransportTime(), this.playing, true);
  };
  private readonly onOriginalTimeUpdate = () => {
    if (this.originalEnabled && this.playing) this.syncOriginal(this.currentTransportTime());
  };

  private ensureContext(): AudioContext {
    if (this.disposed) throw new Error('This audio engine has been disposed');
    if (this.context) return this.context;
    const Constructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) throw new Error('This browser does not support Web Audio');
    const context = new Constructor();
    this.context = context;
    const master = context.createDynamicsCompressor();
    master.threshold.value = -5;
    master.knee.value = 7;
    master.ratio.value = 8;
    master.attack.value = 0.003;
    master.release.value = 0.13;
    const output = context.createGain();
    output.gain.value = 0.82;
    master.connect(output).connect(context.destination);

    this.songBus = context.createGain();
    this.songBus.gain.value = this.volumes.song;
    this.songBus.connect(master);
    this.metronomeBus = context.createGain();
    this.metronomeBus.gain.value = this.volumes.metronome;
    this.metronomeBus.connect(master);
    this.guitarBus = context.createGain();
    this.guitarBus.gain.value = this.volumes.guitar;
    const highPass = context.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 48;
    highPass.Q.value = 0.6;
    const body = context.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 190;
    body.Q.value = 0.8;
    body.gain.value = 3;
    const presence = context.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 880;
    presence.Q.value = 0.75;
    presence.gain.value = 1.8;
    this.guitarBus.connect(highPass).connect(body).connect(presence).connect(master);
    // A short, quiet diffuse room adds a wooden acoustic space without delaying the direct pick.
    const reverb = context.createConvolver();
    const impulse = context.createBuffer(2, Math.round(context.sampleRate * 0.24), context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (context.sampleRate * 0.043)) * Math.min(1, i / (context.sampleRate * 0.006));
    }
    reverb.buffer = impulse;
    const wet = context.createGain();
    wet.gain.value = 0.075;
    presence.connect(reverb).connect(wet).connect(master);
    return context;
  }

  async unlock(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();
    // Sample downloads are an optional timbre upgrade. The physical model in
    // pluckAt is ready as soon as the context resumes, including on cold start.
    void this.loadGuitarSamples().catch(() => undefined);
  }

  async loadSong(backingBlob: Blob, timelineRate = 1, originalBlob?: Blob): Promise<void> {
    const revision = ++this.loadRevision;
    this.pause();
    this.clearOriginal();
    this.buffer = null;
    this.position = 0;
    this.loopStart = 0;
    this.loopEnd = null;
    const nextRate = clamp(finiteOr(timelineRate, 1), 0.5, 1);
    const context = this.ensureContext();
    void this.loadGuitarSamples();
    const encoded = await backingBlob.arrayBuffer();
    if (this.disposed || revision !== this.loadRevision) return;
    const decoded = await context.decodeAudioData(encoded);
    if (this.disposed || revision !== this.loadRevision) return;
    this.buffer = decoded;
    this.timelineRate = nextRate;
    this.position = 0;
    this.loopStart = 0;
    this.loopEnd = null;
    if (originalBlob) this.attachOriginal(originalBlob);
  }

  play(offsetSeconds?: number): void {
    if (this.disposed || !this.buffer) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    let offset = offsetSeconds === undefined ? this.getCurrentTime() : clamp(finiteOr(offsetSeconds, 0), 0, this.logicalDuration());
    this.stopSongSource();
    if (offset >= this.logicalDuration()) offset = 0;
    const loop = this.effectiveLoop();
    if (loop && offset >= loop.end) offset = loop.start + ((offset - loop.start) % (loop.end - loop.start));
    const source = context.createBufferSource();
    const envelope = context.createGain();
    source.buffer = this.buffer;
    source.playbackRate.value = 1;
    if (loop) {
      source.loop = true;
      source.loopStart = loop.start / this.timelineRate;
      source.loopEnd = loop.end / this.timelineRate;
    }
    envelope.gain.setValueAtTime(0, context.currentTime);
    envelope.gain.linearRampToValueAtTime(1, context.currentTime + 0.007);
    source.connect(envelope).connect(this.songBus!);
    this.position = offset;
    this.startedAt = context.currentTime;
    this.playing = true;
    this.songSource = source;
    this.songEnvelope = envelope;
    this.syncOriginal(offset, true, true);
    source.onended = () => {
      source.disconnect();
      envelope.disconnect();
      if (this.songSource !== source) return;
      this.songSource = null;
      this.songEnvelope = null;
      this.playing = false;
      this.position = this.logicalDuration();
      this.syncOriginal(this.position, false, true);
    };
    source.start(context.currentTime, offset / this.timelineRate);
  }

  pause(): void {
    this.position = this.currentTransportTime();
    this.playing = false;
    this.stopSongSource();
    this.syncOriginal(this.position, false, true);
  }

  seek(seconds: number): void {
    const target = clamp(finiteOr(seconds, 0), 0, this.logicalDuration());
    const wasPlaying = this.isPlaying();
    this.playing = false;
    this.stopSongSource();
    this.position = target;
    if (wasPlaying && target < this.logicalDuration()) this.play(target);
    else this.syncOriginal(target, false, true);
  }

  getCurrentTime(): number {
    const current = this.currentTransportTime();
    if (this.originalEnabled && this.playing) this.syncOriginal(current);
    return current;
  }

  private currentTransportTime(): number {
    if (!this.playing || !this.context || !this.buffer) return this.position;
    const raw = this.position + Math.max(0, this.context.currentTime - this.startedAt) * this.timelineRate;
    const loop = this.effectiveLoop();
    if (loop && raw >= loop.end) return loop.start + ((raw - loop.start) % (loop.end - loop.start));
    return Math.min(raw, this.logicalDuration());
  }

  isPlaying(): boolean {
    if (this.playing && !this.effectiveLoop() && this.buffer && this.getCurrentTime() >= this.logicalDuration()) {
      this.position = this.logicalDuration();
      this.playing = false;
      this.stopSongSource();
      this.syncOriginal(this.position, false, true);
    }
    return this.playing;
  }

  setVolumes(volumes: { song?: number; original?: number; guitar?: number; metronome?: number }): void {
    for (const key of ['song', 'original', 'guitar', 'metronome'] as const) {
      const volume = volumes[key];
      if (volume === undefined || !Number.isFinite(volume)) continue;
      this.volumes[key] = clamp(volume, 0, 1);
      if (key === 'original') {
        if (this.originalAudio) this.originalAudio.volume = this.volumes.original;
        continue;
      }
      const bus = key === 'song' ? this.songBus : key === 'guitar' ? this.guitarBus : this.metronomeBus;
      if (bus && this.context) bus.gain.setTargetAtTime(this.volumes[key], this.context.currentTime, 0.015);
    }
  }

  setOriginalEnabled(enabled: boolean): void {
    if (this.disposed) return;
    const position = this.currentTransportTime();
    this.originalEnabled = Boolean(enabled);
    this.syncOriginal(position, this.originalEnabled && this.playing, true);
  }

  setLoop(start: number, end: number | null): void {
    const wasPlaying = this.isPlaying();
    const position = this.getCurrentTime();
    this.loopStart = Math.max(0, finiteOr(start, 0));
    this.loopEnd = end !== null && Number.isFinite(end) && end > this.loopStart ? end : null;
    if (wasPlaying) this.play(position);
  }

  setTechnique(technique: GuitarTechnique): void {
    if (['pick', 'finger', 'muted', 'harmonic'].includes(technique)) this.technique = technique;
  }

  setPickPosition(position: number): void {
    // 0 is close to the bridge (bright); 1 is toward the neck (rounder).
    this.pickPosition = clamp(finiteOr(position, 0.5), 0, 1);
  }

  pluckString(chord: string, stringIndex: number, velocity = 0.75): void {
    if (this.disposed) return;
    const midi = getStringMidi(chord, stringIndex);
    if (!Number.isFinite(velocity) || velocity <= 0) return;
    if (midi === null) {
      const ringing = this.strings.get(stringIndex);
      if (ringing && this.context) this.releaseVoice(ringing, this.context.currentTime);
      return;
    }
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    this.pluckAt(midi, stringIndex, clamp(velocity, 0, 1), context.currentTime);
  }

  /** Give direct interaction audible feedback even on a muted chord string. */
  pluckOpenString(stringIndex: number, velocity = 0.75): void {
    if (this.disposed || !Number.isInteger(stringIndex) || stringIndex < 0 || stringIndex >= OPEN_STRING_MIDI.length
      || !Number.isFinite(velocity) || velocity <= 0) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    this.pluckAt(OPEN_STRING_MIDI[stringIndex], stringIndex, clamp(velocity, 0, 1), context.currentTime);
  }

  /** Play an analysed score note at its written pitch, independent of chord voicing. */
  pluckMidi(midi: number, velocity = 0.75, duration?: number): void {
    if (this.disposed || !Number.isFinite(midi) || midi < 24 || midi > 108 || !Number.isFinite(velocity) || velocity <= 0) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    let stringIndex = 0;
    for (let index = 0; index < OPEN_STRING_MIDI.length; index++) {
      if (midi >= OPEN_STRING_MIDI[index] && midi - OPEN_STRING_MIDI[index] <= 24) stringIndex = index;
    }
    this.pluckAt(midi, stringIndex, clamp(velocity, 0, 1), context.currentTime, true, duration);
  }

  strum(chord: string, direction: StrumDirection = 'down', velocity = 0.75): void {
    if (this.disposed || !Number.isFinite(velocity) || velocity <= 0) return;
    const strings = direction === 'up' ? [5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5];
    const playable = strings.map(index => ({ index, midi: getStringMidi(chord, index) })).filter(note => note.midi !== null);
    if (!playable.length) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const now = context.currentTime;
    playable.forEach(({ index, midi }, order) => {
      this.pluckAt(midi!, index, clamp(velocity * (1 - order * 0.027), 0, 1), now + order * 0.015);
    });
  }

  muteStrings(): void {
    if (!this.context) return;
    for (const voice of this.voices) this.releaseVoice(voice, this.context.currentTime, 0.035);
    this.strings.clear();
  }

  click(accent = false): void {
    if (this.disposed) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const now = context.currentTime;
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(accent ? 1760 : 1175, now);
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(accent ? 0.21 : 0.15, now + 0.0015);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.037);
    oscillator.connect(envelope).connect(this.metronomeBus!);
    this.clicks.add(oscillator);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); this.clicks.delete(oscillator); };
    oscillator.start(now);
    oscillator.stop(now + 0.04);
  }

  drum(accent = false): void {
    if (this.disposed || this.volumes.metronome <= 0) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    let buffer = this.drumBuffers.get(accent);
    if (!buffer) {
      const samples = synthesizePercussion(context.sampleRate, accent);
      buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.getChannelData(0).set(samples);
      this.drumBuffers.set(accent, buffer);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.metronomeBus!);
    this.drums.add(source);
    source.onended = () => { source.disconnect(); this.drums.delete(source); };
    source.start(context.currentTime);
    source.stop(context.currentTime + buffer.duration + 0.005);
  }

  dispose(): void {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    ++this.loadRevision;
    for (const voice of this.voices) { voice.source.onended = null; voice.source.stop(); voice.source.disconnect(); voice.envelope.disconnect(); voice.filter.disconnect(); voice.pan.disconnect(); }
    for (const oscillator of this.clicks) { oscillator.onended = null; oscillator.stop(); oscillator.disconnect(); }
    for (const source of this.drums) { source.onended = null; source.stop(); source.disconnect(); }
    this.voices.clear();
    this.strings.clear();
    this.clicks.clear();
    this.drums.clear();
    this.drumBuffers.clear();
    this.voiceCache.clear();
    this.voiceSequences.clear();
    this.guitarSamples.clear();
    this.guitarSampleLoad = null;
    this.buffer = null;
    this.clearOriginal();
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => undefined);
    this.context = null;
    this.songBus = null;
    this.guitarBus = null;
    this.metronomeBus = null;
  }

  private effectiveLoop(): { start: number; end: number } | null {
    if (!this.buffer || this.loopEnd === null) return null;
    const end = Math.min(this.loopEnd, this.logicalDuration());
    return end > this.loopStart + 0.01 ? { start: this.loopStart, end } : null;
  }

  private logicalDuration(): number {
    return (this.buffer?.duration ?? 0) * this.timelineRate;
  }

  private attachOriginal(blob: Blob): void {
    const AudioConstructor = (globalThis as typeof globalThis & { Audio?: typeof Audio }).Audio;
    if (!AudioConstructor || typeof URL.createObjectURL !== 'function') return;
    let url: string;
    try { url = URL.createObjectURL(blob); } catch { return; }
    try {
      const audio = new AudioConstructor() as PitchPreservingAudioElement;
      audio.preload = 'auto';
      audio.playbackRate = this.timelineRate;
      audio.defaultPlaybackRate = this.timelineRate;
      audio.preservesPitch = true;
      audio.webkitPreservesPitch = true;
      audio.loop = false;
      audio.volume = this.volumes.original;
      audio.muted = !this.originalEnabled;
      audio.addEventListener('loadedmetadata', this.onOriginalMetadata);
      audio.addEventListener('timeupdate', this.onOriginalTimeUpdate);
      audio.src = url;
      this.originalAudio = audio;
      this.originalUrl = url;
      audio.load();
      this.syncOriginal(this.position, false, true);
    } catch {
      if (this.originalUrl === url) this.clearOriginal();
      else try { URL.revokeObjectURL(url); } catch { /* The optional track must not break the transport. */ }
    }
  }

  private clearOriginal(): void {
    const audio = this.originalAudio;
    const url = this.originalUrl;
    this.originalAudio = null;
    this.originalUrl = null;
    if (audio) {
      audio.removeEventListener('loadedmetadata', this.onOriginalMetadata);
      audio.removeEventListener('timeupdate', this.onOriginalTimeUpdate);
      try { audio.pause(); } catch { /* Media cleanup is best-effort. */ }
      try { audio.removeAttribute('src'); audio.load(); } catch { /* The object URL is still revoked below. */ }
    }
    if (url && typeof URL.revokeObjectURL === 'function') {
      try { URL.revokeObjectURL(url); } catch { /* Media is already detached. */ }
    }
  }

  private syncOriginal(position: number, startPlayback = false, forceSeek = false): void {
    const audio = this.originalAudio;
    if (!audio) return;
    audio.playbackRate = this.timelineRate;
    audio.defaultPlaybackRate = this.timelineRate;
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
    audio.volume = this.volumes.original;
    audio.muted = !this.originalEnabled;
    if (forceSeek || !Number.isFinite(audio.currentTime) || Math.abs(audio.currentTime - position) > 0.08) {
      try { audio.currentTime = Math.max(0, position); } catch { /* loadedmetadata retries the seek. */ }
    }
    if (!this.originalEnabled || !this.playing) {
      if (!audio.paused) audio.pause();
      return;
    }
    if (startPlayback && audio.paused) {
      try { void audio.play().catch(() => undefined); } catch { /* Backing playback remains available. */ }
    }
  }

  private stopSongSource(): void {
    const source = this.songSource;
    const envelope = this.songEnvelope;
    this.songSource = null;
    this.songEnvelope = null;
    if (!source || !this.context) return;
    if (envelope) {
      this.holdGain(envelope.gain, this.context.currentTime);
      envelope.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.01);
    }
    source.stop(this.context.currentTime + 0.012);
  }

  private holdGain(gain: AudioParam, time: number): void {
    if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(time);
    else { const value = gain.value; gain.cancelScheduledValues(time); gain.setValueAtTime(value, time); }
  }

  private loadGuitarSamples(): Promise<void> {
    if (this.guitarSampleLoad) return this.guitarSampleLoad;
    const context = this.ensureContext();
    const fetchAudio = globalThis.fetch;
    if (typeof fetchAudio !== 'function' || typeof globalThis.location === 'undefined') return Promise.resolve();
    this.guitarSampleLoad = Promise.all(GUITAR_SAMPLE_MIDIS.map(async midi => {
      try {
        const response = await fetchAudio(`/instruments/fluidr3-acoustic-guitar-nylon/${midi}.mp3`);
        if (!response.ok) return;
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        if (this.disposed || this.context !== context) return;
        let peak = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const samples = buffer.getChannelData(channel);
          for (let index = 0; index < samples.length; index++) peak = Math.max(peak, Math.abs(samples[index]));
        }
        if (peak > 0.0001) {
          const scale = Math.min(8, 0.82 / peak);
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const samples = buffer.getChannelData(channel);
            for (let index = 0; index < samples.length; index++) samples[index] *= scale;
          }
        }
        this.guitarSamples.set(midi, buffer);
      } catch {
        // Physical synthesis remains available if a browser cannot decode MP3 samples.
      }
    })).then(() => undefined);
    return this.guitarSampleLoad;
  }

  private closestGuitarSample(midi: number): { midi: number; buffer: AudioBuffer } | null {
    let closest: { midi: number; buffer: AudioBuffer } | null = null;
    for (const sampleMidi of GUITAR_SAMPLE_MIDIS) {
      const buffer = this.guitarSamples.get(sampleMidi);
      if (!buffer || (closest && Math.abs(midi - closest.midi) <= Math.abs(midi - sampleMidi))) continue;
      closest = { midi: sampleMidi, buffer };
    }
    return closest && Math.abs(midi - closest.midi) <= 1 ? closest : null;
  }

  private releaseVoice(voice: Voice, time: number, release = 0.022): void {
    this.holdGain(voice.envelope.gain, time);
    voice.envelope.gain.linearRampToValueAtTime(0, time + release);
    voice.source.stop(time + release + 0.002);
  }

  private pluckAt(midi: number, stringIndex: number, velocity: number, time: number, preserveMidi = false, scoreDuration?: number): void {
    const context = this.context!;
    if (preserveMidi) {
      // A lead line is monophonic even when successive notes move to another
      // displayed string. Letting every lane ring independently turns the
      // melody into a blurred chord after only a few hits.
      for (const voice of this.voices) {
        if (voice.scoreNote) this.releaseVoice(voice, time, 0.018);
      }
    }
    const previous = this.strings.get(stringIndex);
    if (previous) this.releaseVoice(previous, time);
    if (this.voices.size > 30) {
      const oldest = this.voices.values().next().value;
      if (oldest) this.releaseVoice(oldest, context.currentTime, 0.01);
    }
    const strengthBucket = Math.round(velocity * 3) / 3;
    const positionBucket = Math.round(this.pickPosition * 5) / 5;
    const voiceKey = `${midi}:${this.technique}:${strengthBucket}:${positionBucket}:${preserveMidi ? 'score' : 'fret'}`;
    const sequence = this.voiceSequences.get(voiceKey) ?? 0;
    const variation = sequence % VOICE_VARIANTS;
    this.voiceSequences.set(voiceKey, sequence + 1);
    const sampled = this.technique === 'harmonic' ? null : this.closestGuitarSample(midi);
    let playbackRate = 1;
    let buffer: AudioBuffer;
    if (sampled) {
      buffer = sampled.buffer;
      playbackRate = 2 ** ((midi - sampled.midi) / 12);
    } else {
      const cacheKey = `${voiceKey}:${variation}`;
      const cached = this.voiceCache.get(cacheKey);
      if (cached) {
        buffer = cached;
      } else {
        const samples = renderPluckedString(context.sampleRate, midi, this.technique, strengthBucket, positionBucket, variation, !preserveMidi);
        buffer = context.createBuffer(1, samples.length, context.sampleRate);
        buffer.getChannelData(0).set(samples);
        this.voiceCache.set(cacheKey, buffer);
        if (this.voiceCache.size > MAX_VOICE_CACHE) this.voiceCache.delete(this.voiceCache.keys().next().value!);
      }
    }
    const source = context.createBufferSource();
    const envelope = context.createGain();
    const filter = context.createBiquadFilter();
    const pan = context.createStereoPanner();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    source.detune.value = VOICE_DETUNE[variation];
    filter.type = 'lowpass';
    filter.Q.value = 0.35;
    const brightness = this.technique === 'finger' ? 3200 : this.technique === 'muted' ? 2400 : 7800;
    filter.frequency.setValueAtTime(1000 + brightness * velocity ** 0.8, time);
    filter.frequency.exponentialRampToValueAtTime(this.technique === 'harmonic' ? 2300 : 1200, time + Math.min(1.2, buffer.duration * 0.7));
    pan.pan.value = clamp((stringIndex - 2.5) * 0.065, -0.3, 0.3);
    const amplitude = (0.04 + velocity ** 1.05 * 0.97) * (this.technique === 'harmonic' ? 0.86 : 1);
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(amplitude, time + 0.001);
    const naturalDuration = buffer.duration / playbackRate;
    const audibleDuration = preserveMidi && Number.isFinite(scoreDuration)
      ? clamp(scoreDuration! + 0.14, 0.2, Math.min(2.4, naturalDuration))
      : naturalDuration;
    envelope.gain.setValueAtTime(amplitude, time + Math.max(0.002, audibleDuration - 0.09));
    envelope.gain.linearRampToValueAtTime(0, time + audibleDuration);
    source.connect(filter).connect(envelope).connect(pan).connect(this.guitarBus!);
    const voice: Voice = { source, envelope, filter, pan, stringIndex, scoreNote: preserveMidi };
    this.voices.add(voice);
    this.strings.set(stringIndex, voice);
    source.onended = () => {
      source.disconnect(); filter.disconnect(); envelope.disconnect(); pan.disconnect();
      this.voices.delete(voice);
      if (this.strings.get(stringIndex) === voice) this.strings.delete(stringIndex);
    };
    source.start(time);
    source.stop(time + audibleDuration + 0.01);
  }
}
