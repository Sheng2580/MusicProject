import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ArrowDown, ArrowUp, AudioLines, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Download, ExternalLink, FileMusic, FolderOpen, Guitar, Headphones, Keyboard, ListMusic, LoaderCircle, MousePointer2, Music2, Pause, PencilLine, Play, Plus, Repeat2, RotateCcw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload, Volume2, X } from 'lucide-react';
import GuitarStage from './GuitarStage';
import LibraryView from './LibraryView';
import ImmersivePlayer from './ImmersivePlayer';
import { AudioEngine, ALL_CHORDS, getStringMidi } from './lib/audioEngine';
import type { GuitarTechnique } from './lib/audioEngine';
import { analyzeAudio } from './lib/analysis';
import { isMp3FileName, MP3_FILE_ACCEPT } from './lib/audioImport';
import { renderAccompaniment } from './lib/accompaniment';
import { resolveBackingTrack } from './lib/playbackTrack';
import type { BackingKind } from './lib/playbackTrack';
import { PlaybackStartGate, runGuardedPlaybackStart } from './lib/playbackStart';
import { isPracticeClockPlaying, practiceChordMatches, practiceClockTime, resolveKeyboardStrum, resolvePracticeSound } from './lib/practiceSession';
import type { PracticeLeadIn } from './lib/practiceSession';
import { getSongs, saveSong, removeSong, replaceSongIfFileMatches, sameSongAudioRevision, saveSongCover, updateSongIfFileMatches } from './lib/storage';
import { coverForAudioRevision, isEmbeddedCover, readSongMetadata, lookupSongCover } from './lib/songMetadata';
import { applyLocalAudioReanalysis, hasPlayableMelody, LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION, needsLocalAudioRetranscription } from './lib/songCompatibility';
import { attachDemoMelody, demoAudioMatches, mergeDemoMelodyUpgrade, readKnownDemoIds, serializeKnownDemoIds, verifyDemoAudio } from './lib/demoCatalog';
import { chordAt, formatTime, nearestBeat, replaceChordBoundary, validateBoundaries, isHighMatch, timingGrade } from './lib/game';
import { createPracticeChart, nearestPracticeCue, nearestPracticeCueOnString, normalizeMelodyNotes, PRACTICE_FLIGHT_SECONDS } from './lib/performanceChart';
import type { AnalysisProgress, ChordSegment, PlayMode, PracticeCue, PracticeHit, SongAnalysis, SongRecord, StrumDirection } from './types';

interface DemoTrack { id: string; title: string; artist: string; fileName: string; url: string; melodyUrl?: string; backingUrl?: string; bpm?: number; sourceUrl: string; sourceLabel: string; preview: boolean; version: string; audioBytes: number; audioSha256: string }
interface Score { perfect: number; good: number; missed: number; combo: number; best: number }
const EMPTY_SCORE: Score = { perfect: 0, good: 0, missed: 0, combo: 0, best: 0 };
const START_WAIT_SECONDS = 3;
const STRING_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH'] as const;
const TECHNIQUES: { id: GuitarTechnique; label: string; description: string }[] = [
  { id: 'pick', label: '拨片', description: '清亮、有颗粒感' },
  { id: 'finger', label: '指腹', description: '温暖、轻柔' },
  { id: 'muted', label: '闷音', description: '短促、干净' },
  { id: 'harmonic', label: '泛音', description: '十二品泛音模拟' },
];

async function loadDemoMelody(demo: DemoTrack, duration: number) {
  if (!demo.melodyUrl) return undefined;
  const response = await fetch(demo.melodyUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${demo.title} 的逐音旋律数据无法读取。`);
  const melody = normalizeMelodyNotes(await response.json(), duration);
  if (melody.length < 8) throw new Error(`${demo.title} 的逐音旋律数据不完整。`);
  return melody;
}

function demoSource(demo: DemoTrack, audioSha256: string): NonNullable<SongRecord['source']> {
  return {
    label: demo.sourceLabel,
    url: demo.sourceUrl,
    preview: demo.preview,
    version: demo.version,
    backingUrl: demo.backingUrl,
    audioSha256,
    audioSha256Verified: true,
  };
}

function Waveform({ values, progress = 0 }: { values: number[]; progress?: number }) {
  return <svg className="waveform" viewBox="0 0 900 50" preserveAspectRatio="none" aria-hidden="true">{values.filter((_, i) => i % Math.max(1, Math.floor(values.length / 240)) === 0).slice(0, 240).map((v, i, all) => <line key={i} x1={i * 900 / all.length} x2={i * 900 / all.length} y1={25 - Math.max(1.2, v * 22)} y2={25 + Math.max(1.2, v * 22)} stroke={i / all.length <= progress ? '#64735c' : '#d8dcd0'} strokeWidth="2.2" strokeLinecap="round" />)}</svg>;
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;
  const [songs, setSongs] = useState<SongRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [screen, setScreen] = useState<'library' | 'session'>('library');
  const [hitCue, setHitCue] = useState<PracticeHit | null>(null);
  const [hitEvents, setHitEvents] = useState<PracticeHit[]>([]);
  const [practiceRevision, setPracticeRevision] = useState(0);
  const [tab, setTab] = useState<'play' | 'score'>('play');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState<AnalysisProgress & { title: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [mode, setMode] = useState<PlayMode>('free');
  const practiceRate = 1;
  const [backingEnabled, setBackingEnabled] = useState(false);
  const [backingKind, setBackingKind] = useState<BackingKind | null>(null);
  const [originalEnabled, setOriginalEnabled] = useState(false);
  const [rhythmEnabled, setRhythmEnabled] = useState(false);
  const [manualChord, setManualChord] = useState('C');
  const [technique, setTechnique] = useState<GuitarTechnique>('pick');
  const [strumEvent, setStrumEvent] = useState<{ at: number; direction: StrumDirection } | null>(null);
  const [stringEvent, setStringEvent] = useState<{ at: number; index: number } | null>(null);
  const [score, setScore] = useState<Score>(EMPTY_SCORE);
  const [judgment, setJudgment] = useState('准备好，弹出你的节奏');
  const [volumes, setVolumes] = useState({ song: .35, original: .42, guitar: .8, metronome: .4 });
  const [loop, setLoop] = useState<[number, number] | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editChord, setEditChord] = useState('C');
  const [editStart, setEditStart] = useState('0');
  const [editEnd, setEditEnd] = useState('0');
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [help, setHelp] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [demos, setDemos] = useState<DemoTrack[]>([]);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const booted = useRef(false);
  const importing = useRef(false);
  const coverAttempts = useRef(new Set<string>());
  const judgedCues = useRef(new Set<string>());
  const lastMetronome = useRef(-1);
  const lastTime = useRef(0);
  const selected = songs.find(s => s.id === activeId) ?? null;
  const completeChart = useMemo(() => selected ? createPracticeChart(selected.analysis) : [], [selected?.analysis]);
  const practiceCues = completeChart;
  const stateRef = useRef({ selected, mode, manualChord, loop, playing, backingEnabled, rhythmEnabled, practiceRate, practiceCues });
  stateRef.current = { selected, mode, manualChord, loop, playing, backingEnabled, rhythmEnabled, practiceRate, practiceCues };
  const noteRevision = useRef(0);
  const lastSoundedCue = useRef<{ id: string; at: number } | null>(null);
  const leadIn = useRef<PracticeLeadIn | null>(null);
  const leadInTimer = useRef<number | null>(null);
  const playbackStart = useRef(new PlaybackStartGate());

  const invalidatePendingNotes = useCallback(() => {
    noteRevision.current++;
    lastSoundedCue.current = null;
  }, []);
  const resetCueState = useCallback(() => {
    invalidatePendingNotes();
    judgedCues.current.clear();
    setHitCue(null);
    setHitEvents([]);
    setPracticeRevision(revision => revision + 1);
  }, [invalidatePendingNotes]);

  const showToast = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const cancelLeadIn = useCallback(() => {
    playbackStart.current.cancel();
    if (leadInTimer.current !== null) window.clearTimeout(leadInTimer.current);
    leadInTimer.current = null;
    leadIn.current = null;
  }, []);
  const stopPlaybackImmediately = useCallback(() => {
    cancelLeadIn();
    invalidatePendingNotes();
    engine.pause();
    setPlaying(false);
  }, [cancelLeadIn, engine, invalidatePendingNotes]);
  const openAudioPicker = useCallback(() => {
    stopPlaybackImmediately();
    inputRef.current?.click();
  }, [stopPlaybackImmediately]);
  useEffect(() => cancelLeadIn, [cancelLeadIn]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(null), toast.error ? 8500 : 4000); return () => clearTimeout(timeout); }, [toast]);

  const buildSong = useCallback(async (blob: Blob, fileName: string, demo?: DemoTrack, previous?: SongRecord): Promise<SongRecord> => {
    const verifiedSource = demo ? demoSource(demo, await verifyDemoAudio(blob, demo)) : undefined;
    const metadata = await readSongMetadata(blob, fileName);
    const title = demo?.title ?? previous?.title ?? metadata.title;
    setLoading({ title, progress: 0, stage: '读取音频' });
    let analysis = await analyzeAudio(blob, p => setLoading({
      ...p,
      progress: demo?.melodyUrl ? Math.min(.94, p.progress * .94) : p.progress,
      title,
    }), { melody: !demo?.melodyUrl });
    if (demo?.melodyUrl) {
      setLoading({ title, progress: .96, stage: '正在载入逐音旋律数据…' });
      analysis = attachDemoMelody(analysis, await loadDemoMelody(demo, analysis.duration) ?? [], demo.bpm);
      setLoading({ title, progress: .99, stage: '正在保存本地曲目…' });
    }
    return {
      id: demo?.id ?? previous?.id ?? crypto.randomUUID(), title, artist: demo?.artist ?? previous?.artist ?? metadata.artist ?? '未知歌手', cover: metadata.cover ?? previous?.cover, fileName, audio: blob,
      analysis, originalAnalysis: structuredClone(analysis), createdAt: previous?.createdAt ?? Date.now(),
      ...(demo ? {} : { localAnalysisPipelineVersion: LOCAL_AUDIO_ANALYSIS_PIPELINE_VERSION }),
      source: verifiedSource,
    };
  }, []);

  const importAudio = useCallback(async (blob: Blob, fileName: string, demo?: DemoTrack, previous?: SongRecord): Promise<SongRecord> => {
    const song = await buildSong(blob, fileName, demo, previous);
    await saveSong(song);
    setSongs(rows => [...rows.filter(row => row.id !== song.id), song].sort((a, b) => a.createdAt - b.createdAt));
    setActiveId(song.id);
    setLoading(null);
    return song;
  }, [buildSong]);

  const upgradeDemoMelody = useCallback(async (demo: DemoTrack, saved: SongRecord): Promise<SongRecord | null> => {
    const verifiedAudioSha256 = saved.source?.audioSha256;
    if (saved.source?.audioSha256Verified !== true || !verifiedAudioSha256) {
      throw new Error(`${demo.title} 的缓存音频尚未通过完整性校验。`);
    }
    setLoading({ title: demo.title, progress: .94, stage: '正在升级逐音旋律数据…' });
    const melody = await loadDemoMelody(demo, saved.analysis.duration);
    if (!melody) throw new Error(`${demo.title} 的逐音旋律数据无法读取。`);
    const updated = await updateSongIfFileMatches(
      saved.id,
      saved.fileName,
      saved.source?.version,
      current => {
        if (
          current.source?.audioSha256Verified !== true
          || current.source.audioSha256 !== verifiedAudioSha256
          || current.audio.size !== demo.audioBytes
        ) return null;
        const upgradedAnalysis = mergeDemoMelodyUpgrade(current, melody, demo.bpm);
        return {
          ...current,
          title: demo.title,
          artist: demo.artist,
          ...upgradedAnalysis,
          source: demoSource(demo, verifiedAudioSha256),
        };
      },
    );
    setLoading({ title: demo.title, progress: .99, stage: '正在保存本地曲目…' });
    if (updated) setSongs(rows => rows.map(row => row.id === updated.id ? updated : row));
    return updated;
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      importing.current = true;
      try {
        const existing = await getSongs();
        // Do not expose legacy demo rows while their copied catalog hash is
        // being replaced by a digest proven from the stored audio bytes.
        const initiallyTrusted = existing.filter(song => !song.source || song.source.audioSha256Verified === true);
        setSongs(initiallyTrusted);
        if (initiallyTrusted.length) setActiveId(initiallyTrusted[0].id);
        const response = await fetch('/demo/tracks.json');
        if (!response.ok) throw new Error('示例曲目暂时无法读取，你仍可以导入本地音乐。');
        const tracks = await response.json() as DemoTrack[];
        setDemos(tracks);
        const initialized = localStorage.getItem('musicproject-demo-initialized') === '1';
        const knownDemoIds = readKnownDemoIds(localStorage.getItem('musicproject-known-demo-ids'), initialized);
        let complete = true;
        for (const track of tracks) {
          const saved = existing.find(song => song.id === track.id);
          const savedAudioMatches = saved ? await demoAudioMatches(saved, track) : false;
          if (saved && savedAudioMatches && saved.source?.version === track.version && hasPlayableMelody(saved.analysis)) {
            knownDemoIds.add(track.id);
            continue;
          }
          if (!saved && knownDemoIds.has(track.id)) continue;
          try {
            if (saved && savedAudioMatches && track.melodyUrl) {
              await upgradeDemoMelody(track, saved);
              knownDemoIds.add(track.id);
              continue;
            }
            const audio = await fetch(track.url);
            if (!audio.ok) throw new Error(`${track.title} 的音频文件无法读取。`);
            const replacement = await buildSong(await audio.blob(), track.fileName, track, saved);
            if (saved) {
              const replaced = await replaceSongIfFileMatches(replacement, saved.fileName, saved.source?.version, saved.analysis);
              if (replaced) {
                setSongs(rows => {
                  const current = rows.find(row => row.id === saved.id);
                  if (current && (current.fileName !== saved.fileName || current.source?.version !== saved.source?.version)) return rows;
                  const next = current
                    ? { ...replacement, createdAt: current.createdAt, cover: coverForAudioRevision(current.cover, replacement.cover) }
                    : replacement;
                  return [...rows.filter(row => row.id !== saved.id), next].sort((a, b) => a.createdAt - b.createdAt);
                });
              }
            } else {
              await saveSong(replacement);
              setSongs(rows => rows.some(row => row.id === replacement.id)
                ? rows
                : [...rows, replacement].sort((a, b) => a.createdAt - b.createdAt));
            }
            knownDemoIds.add(track.id);
          } catch (error) {
            complete = false;
            showToast(error instanceof Error ? error.message : '内置曲目分析失败', true);
          }
        }
        localStorage.setItem('musicproject-known-demo-ids', serializeKnownDemoIds(knownDemoIds));
        if (!initialized && complete) localStorage.setItem('musicproject-demo-initialized', '1');
      } catch (error) { showToast(error instanceof Error ? error.message : '读取曲库失败', true); }
      finally { setLoading(null); importing.current = false; }
    })();
  }, [buildSong, showToast, upgradeDemoMelody]);

  useEffect(() => {
    // Artwork is optional: never hold up analysis or interrupt a playing song.
    for (const song of songs) {
      const coverAttemptKey = [song.id, song.createdAt, song.fileName, song.audio.size, song.audio.type,
        song.source?.version ?? '', song.source?.audioSha256 ?? ''].join(':');
      if (isEmbeddedCover(song.cover) || coverAttempts.current.has(coverAttemptKey)) continue;
      coverAttempts.current.add(coverAttemptKey);
      void (async () => {
        const metadata = await readSongMetadata(song.audio, song.fileName);
        const artist = ['未知歌手', '我的本地音乐'].includes(song.artist) ? metadata.artist : song.artist;
        const cover = metadata.cover ?? (song.cover ? null : await lookupSongCover(song.title, artist));
        if (!cover) return;
        const replaceExisting = Boolean(metadata.cover);
        const saved = await saveSongCover(song, cover, replaceExisting);
        if (!saved) return;
        setSongs(rows => rows.map(row => sameSongAudioRevision(row, song) && (replaceExisting || !row.cover) ? { ...row, cover } : row));
      })().catch(() => {
        coverAttempts.current.delete(coverAttemptKey);
        // A missing cover uses the shared default.
      });
    }
  }, [songs]);

  useEffect(() => {
    cancelLeadIn();
    engine.pause();
    engine.seek(0);
    engine.muteStrings();
    engine.setLoop(0, null);
    setPlaying(false); setTime(0); setReady(false); setLoop(null); setEditId(null); setScore(EMPTY_SCORE);
    resetCueState(); lastMetronome.current = -1; lastTime.current = 0;
    if (selected) {
      setManualChord(selected.analysis.chords.find(c => c.chord !== 'N')?.chord ?? 'C');
    }
  // Audio should only reload on song changes, never when editing its score.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, engine, showToast, cancelLeadIn, resetCueState]);

  useEffect(() => {
    if (!selected) return;
    cancelLeadIn();
    let alive = true;
    const position = engine.getCurrentTime();
    const controller = new AbortController();
    engine.pause(); setPlaying(false); setReady(false); setBackingKind(null); setLoop(null);
    void (async () => {
      try {
        const resolved = await resolveBackingTrack(selected, practiceRate, { signal: controller.signal });
        if (!alive) return;
        try {
          await engine.loadSong(resolved.blob, practiceRate, selected.audio);
          if (!alive) return;
          setBackingKind(resolved.kind);
          if (resolved.fallbackError) showToast('真实无人声伴奏暂时无法读取，已改用本地合成伴奏。');
        } catch (decodeError) {
          if (resolved.kind !== 'separated' || !alive) throw decodeError;
          const fallback = renderAccompaniment(selected.analysis, practiceRate);
          await engine.loadSong(fallback, practiceRate, selected.audio);
          if (!alive) return;
          setBackingKind('generated');
          showToast('真实无人声伴奏无法解码，已改用本地合成伴奏。');
        }
        engine.seek(position);
        setReady(true);
      } catch (error) {
        if (alive && !controller.signal.aborted) showToast(`伴奏载入失败：${error instanceof Error ? error.message : '未知错误'}`, true);
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [activeId, selected?.analysis, practiceRate, engine, showToast, cancelLeadIn]);

  useEffect(() => { engine.setTechnique(technique); }, [engine, technique]);
  useEffect(() => {
    engine.setOriginalEnabled(originalEnabled);
    engine.setVolumes({ ...volumes, song: backingEnabled ? volumes.song : 0, original: originalEnabled ? volumes.original : 0, metronome: rhythmEnabled ? .55 : 0 });
  }, [engine, volumes, backingEnabled, originalEnabled, rhythmEnabled]);

  useEffect(() => {
    let frame = 0;
    let lastUiFrame = 0;
    const animate = () => {
      const current = engine.getCurrentTime();
      const state = stateRef.current;
      const countingIn = leadIn.current !== null;
      if (engine.isPlaying()) {
        if (performance.now() - lastUiFrame >= 33) { setTime(current); lastUiFrame = performance.now(); }
        if (current < lastTime.current - .08) { resetCueState(); lastMetronome.current = -1; }
        const sourceBeats = state.selected?.analysis.beats ?? [];
        const nearest = nearestBeat(sourceBeats, current);
        if (state.rhythmEnabled && nearest && Math.abs(nearest.difference) < .04 * state.practiceRate && nearest.index !== lastMetronome.current) {
          engine.drum(nearest.index % 4 === 0); lastMetronome.current = nearest.index;
        }
        if (state.mode !== 'free') {
          const missed: string[] = [];
          for (const cue of state.practiceCues) {
            if (cue.time < (state.loop?.[0] ?? 0) || cue.time > (state.loop?.[1] ?? Infinity)) continue;
            if (cue.time < current - .22 * state.practiceRate && cue.time >= lastTime.current - .25 * state.practiceRate && !judgedCues.current.has(cue.id)) missed.push(cue.id);
          }
          if (missed.length) { missed.forEach(id => judgedCues.current.add(id)); setScore(s => ({ ...s, missed: s.missed + missed.length, combo: 0 })); }
        }
      } else if (state.playing && !countingIn) {
        setPlaying(false); setTime(current);
      }
      lastTime.current = current;
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [engine, resetCueState]);

  const wake = useCallback(() => { void engine.unlock().catch(() => showToast('请点击播放按钮，允许浏览器启动声音。', true)); }, [engine, showToast]);
  const getPracticeTime = useCallback(() => practiceClockTime(
    engine.getCurrentTime(),
    leadIn.current,
    performance.now(),
  ), [engine]);
  const isPracticePlaying = useCallback(() => isPracticeClockPlaying(
    engine.isPlaying(),
    leadIn.current,
  ), [engine]);
  const getJudgedCueIds = useCallback((): ReadonlySet<string> => judgedCues.current, []);
  const scoreGesture = useCallback((stringIndex: number): PracticeCue | null => {
    const state = stateRef.current;
    if (!isPracticePlaying() || !state.selected || state.mode === 'free') return null;
    const now = performance.now();
    const current = getPracticeTime();
    const matchingCue = nearestPracticeCueOnString(
      state.practiceCues,
      current,
      stringIndex,
      .18 * state.practiceRate,
      judgedCues.current,
    );
    const nearest = matchingCue ?? nearestPracticeCue(state.practiceCues, current, judgedCues.current);
    if (!nearest) return null;
    if (!matchingCue) {
      const timingDifference = nearest.difference / state.practiceRate;
      if (Math.abs(timingDifference) > .18) {
        setJudgment(nearest.difference < 0 ? '稍早一点，等音符抵达' : '稍晚一点，跟住下一个音');
      } else {
        setJudgment(`拨第 ${6 - nearest.cue.stringIndex} 弦，跟住这颗音符`);
      }
      return null;
    }
    const timingDifference = matchingCue.difference / state.practiceRate;
    const target = chordAt(state.selected.analysis.chords, matchingCue.cue.time)?.chord;
    if (!practiceChordMatches(state.mode, target, state.manualChord)) {
      setJudgment(`换到 ${target}，再拨响琴弦`);
      setScore(s => ({ ...s, combo: 0 }));
      return null;
    }
    judgedCues.current.add(matchingCue.cue.id);
    const perfect = timingGrade(timingDifference) === 'perfect';
    const hit = { cueId: matchingCue.cue.id, at: now, perfect };
    setHitCue(hit);
    setHitEvents(events => [...events, hit].slice(-64));
    setJudgment(perfect ? '漂亮！正好落在这个音' : matchingCue.difference < 0 ? '不错 · 轻微偏早' : '不错 · 轻微偏晚');
    setScore(s => ({ ...s, perfect: s.perfect + Number(perfect), good: s.good + Number(!perfect), combo: s.combo + 1, best: Math.max(s.best, s.combo + 1) }));
    return matchingCue.cue;
  }, [getPracticeTime, isPracticePlaying]);

  const currentChord = chordAt(selected?.analysis.chords ?? [], time);
  const soundingChord = mode === 'easy' ? currentChord?.chord ?? 'C' : manualChord;
  const soundingRef = useRef(soundingChord); soundingRef.current = soundingChord;
  const pluck = useCallback((index: number, velocity: number, direction: StrumDirection, position: number) => {
    const state = stateRef.current;
    const chord = state.mode === 'easy' ? chordAt(state.selected?.analysis.chords ?? [], engine.getCurrentTime())?.chord ?? 'C' : state.manualChord;
    const sound = resolvePracticeSound(state.mode, isPracticePlaying(), scoreGesture(index));
    const revision = noteRevision.current;
    void engine.unlock().then(() => {
      if (revision !== noteRevision.current) return;
      engine.setPickPosition(position);
      if (sound.kind === 'cue') {
        const now = performance.now();
        const previous = lastSoundedCue.current;
        // One mouse sweep crosses several lanes within a few milliseconds.
        // Coalesce those crossings so they produce one target note, not a
        // stutter followed by five unrelated chord tones.
        if (previous?.id === sound.cue.id && now - previous.at < 100) return;
        lastSoundedCue.current = { id: sound.cue.id, at: now };
        engine.pluckMidi(sound.cue.midi, velocity, sound.cue.duration);
      }
      else if (sound.kind === 'instrument') {
        if (getStringMidi(chord, index) !== null) engine.pluckString(chord, index, velocity);
        else engine.pluckOpenString(index, velocity);
      }
    }).catch(() => showToast('声音启动失败，请重新点击播放。', true));
    void direction;
  }, [engine, isPracticePlaying, scoreGesture, showToast]);
  const mute = useCallback(() => { invalidatePendingNotes(); engine.muteStrings(); }, [engine, invalidatePendingNotes]);
  const returnToLibrary = useCallback(() => {
    stopPlaybackImmediately();
    mute();
    setScreen('library');
  }, [mute, stopPlaybackImmediately]);

  const toggleBacking = useCallback(() => {
    const next = !stateRef.current.backingEnabled;
    engine.setVolumes({ song: next ? volumes.song : 0 });
    setBackingEnabled(next);
    if (next) {
      wake();
      showToast(backingKind === 'separated' ? '伴奏已开启 · 原曲分离的完整无人声音轨' : '伴奏已开启 · 根据自动分析在本机生成');
    }
  }, [engine, volumes.song, wake, showToast, backingKind]);

  const toggleOriginal = useCallback(() => {
    const next = !originalEnabled;
    engine.setOriginalEnabled(next);
    engine.setVolumes({ original: next ? volumes.original : 0 });
    setOriginalEnabled(next);
    if (next) { wake(); showToast('原声已开启 · 播放你导入的音频，可与合成伴奏独立开关'); }
  }, [engine, originalEnabled, volumes.original, wake, showToast]);

  const togglePlay = useCallback(async () => {
    if (!stateRef.current.selected || !ready) return;
    if (playbackStart.current.isPending || leadIn.current || engine.isPlaying()) {
      stopPlaybackImmediately();
      return;
    }
    try {
      await runGuardedPlaybackStart(playbackStart.current, () => engine.unlock(), () => {
        const position = engine.getCurrentTime();
        const firstCue = stateRef.current.practiceCues.find(cue => cue.time >= position - .01);
        const leadSeconds = stateRef.current.mode !== 'free' && position <= .05 && firstCue
          ? Math.max(0, PRACTICE_FLIGHT_SECONDS - (firstCue.time - position))
          : 0;
        const sequence: PracticeLeadIn = {
          phase: 'waiting',
          startedAt: 0,
          from: position - leadSeconds,
          target: position,
        };
        const beginAudio = () => {
          if (leadIn.current !== sequence) return;
          leadInTimer.current = null;
          leadIn.current = null;
          engine.play(position);
          setPlaying(engine.isPlaying());
        };
        leadIn.current = sequence;
        setPlaying(true);
        leadInTimer.current = window.setTimeout(() => {
          if (leadIn.current !== sequence) return;
          leadInTimer.current = null;
          if (leadSeconds > .05) {
            sequence.phase = 'falling';
            sequence.startedAt = performance.now();
            leadInTimer.current = window.setTimeout(beginAudio, leadSeconds * 1000);
          } else {
            beginAudio();
          }
        }, START_WAIT_SECONDS * 1000);
      });
    } catch (error) { stopPlaybackImmediately(); showToast(error instanceof Error ? error.message : '播放失败', true); }
  }, [engine, ready, showToast, stopPlaybackImmediately]);

  const restartPractice = useCallback(() => {
    const resume = leadIn.current !== null || engine.isPlaying();
    stopPlaybackImmediately();
    engine.seek(0);
    engine.setLoop(0, null);
    engine.muteStrings();
    lastTime.current = 0;
    lastMetronome.current = -1;
    resetCueState();
    setLoop(null);
    setTime(0);
    setScore(EMPTY_SCORE);
    if (resume) void togglePlay();
  }, [engine, stopPlaybackImmediately, togglePlay, resetCueState]);

  const strum = useCallback((direction: StrumDirection) => {
    const state = stateRef.current;
    const sound = resolveKeyboardStrum(
      state.mode,
      isPracticePlaying(),
      state.practiceCues,
      getPracticeTime(),
      judgedCues.current,
      .18 * state.practiceRate,
    );
    if (sound.kind === 'cue') {
      pluck(sound.cue.stringIndex, .7, direction, .68);
      setStringEvent({ at: performance.now(), index: sound.cue.stringIndex });
      return;
    }
    if (sound.kind === 'silent') {
      return;
    }
    const revision = noteRevision.current;
    const detected = state.mode === 'easy' ? chordAt(state.selected?.analysis.chords ?? [], engine.getCurrentTime())?.chord : undefined;
    const chord = detected && detected !== 'N' ? detected : state.manualChord;
    void engine.unlock().then(() => { if (revision === noteRevision.current) engine.strum(chord, direction, .7); }).catch(() => showToast('声音启动失败，请再试一次。', true));
    setStrumEvent({ at: performance.now(), direction });
  }, [engine, getPracticeTime, isPracticePlaying, pluck, showToast]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (screen !== 'session' || tab !== 'play') return;
      if (event.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable)) return;
      if (event.target instanceof HTMLButtonElement && ['Space', 'Enter'].includes(event.code)) return;
      if (event.repeat) return;
      if (event.code === 'Space') { event.preventDefault(); void togglePlay(); }
      if (event.code === 'KeyJ') { event.preventDefault(); strum('down'); }
      if (event.code === 'KeyK') { event.preventDefault(); strum('up'); }
      if (event.code === 'KeyM') { event.preventDefault(); mute(); }
      const stringIndex = STRING_KEYS.indexOf(event.code as typeof STRING_KEYS[number]);
      if (stringIndex >= 0) {
        event.preventDefault();
        pluck(stringIndex, .72, stringIndex < 3 ? 'down' : 'up', .68);
        setStringEvent({ at: performance.now(), index: stringIndex });
      }
      const slot = Number(event.key) - 1;
      const palette = [...new Set(stateRef.current.selected?.analysis.chords.filter(c => c.chord !== 'N').map(c => c.chord) ?? ['C', 'G', 'Am', 'F'])];
      if (slot >= 0 && slot < 8 && palette[slot] && stateRef.current.mode !== 'easy') setManualChord(palette[slot]);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [togglePlay, strum, mute, pluck, screen, tab]);

  const onFiles = async (files: FileList | File[]) => {
    if (importing.current) { showToast('正在分析歌曲，完成后就可以继续导入。'); return; }
    importing.current = true; stopPlaybackImmediately();
    let count = 0;
    try {
      for (const file of Array.from(files)) {
        if (!isMp3FileName(file.name)) { showToast(`${file.name}：玩家端只支持导入 MP3 文件。`, true); continue; }
        try { await importAudio(file, file.name); count++; }
        catch (error) { showToast(`${file.name}：${error instanceof Error ? error.message : '分析失败'}`, true); }
      }
      if (count) showToast(`${count} 首歌曲已加入本地曲库`);
    } finally { setLoading(null); importing.current = false; if (inputRef.current) inputRef.current.value = ''; }
  };

  const loadDemo = async (demo: DemoTrack) => {
    const existing = songs.find(s => s.id === demo.id);
    if (importing.current) return;
    stopPlaybackImmediately();
    importing.current = true;
    try {
      const existingAudioMatches = existing ? await demoAudioMatches(existing, demo) : false;
      if (existing && existingAudioMatches && existing.source?.version === demo.version && hasPlayableMelody(existing.analysis)) {
        setActiveId(existing.id);
        return;
      }
      if (existing && existingAudioMatches && demo.melodyUrl) {
        const updated = await upgradeDemoMelody(demo, existing);
        if (updated) setActiveId(updated.id);
        return;
      }
      const response = await fetch(demo.url);
      if (!response.ok) throw new Error('内置音频读取失败');
      const replacement = await buildSong(await response.blob(), demo.fileName, demo, existing);
      if (existing) {
        const replaced = await replaceSongIfFileMatches(replacement, existing.fileName, existing.source?.version, existing.analysis);
        if (!replaced) throw new Error('曲目在升级期间已被修改，请再试一次。');
        setSongs(rows => rows.map(row => row.id === existing.id
          ? { ...replacement, createdAt: row.createdAt, cover: coverForAudioRevision(row.cover, replacement.cover) }
          : row));
        setActiveId(replacement.id);
      } else {
        await saveSong(replacement);
        setSongs(rows => rows.some(row => row.id === replacement.id)
          ? rows
          : [...rows, replacement].sort((a, b) => a.createdAt - b.createdAt));
        setActiveId(replacement.id);
      }
    }
    catch (error) { showToast(error instanceof Error ? error.message : '导入失败', true); }
    finally { setLoading(null); importing.current = false; }
  };

  const seek = (newTime: number) => {
    const wasCountingIn = leadIn.current !== null;
    cancelLeadIn();
    engine.seek(newTime); setTime(newTime); lastTime.current = newTime;
    if (wasCountingIn) setPlaying(false);
    resetCueState(); lastMetronome.current = -1;
    // Seeking begins a new practice take; earlier beats are not counted as misses.
    setScore(EMPTY_SCORE);
  };
  const enterSong = (id: string) => { stopPlaybackImmediately(); resetCueState(); setActiveId(id); setTab('play'); setScreen('session'); setMode('easy'); setJudgment('准备好，弹出你的节奏'); };
  const changeSong = async (id: string) => {
    const song = songs.find(candidate => candidate.id === id);
    if (!song) return;
    if (importing.current) { showToast('正在分析歌曲，完成后再试。'); return; }
    if (!needsLocalAudioRetranscription(song)) { enterSong(id); return; }
    importing.current = true;
    stopPlaybackImmediately();
    try {
      const rebuilt = await buildSong(song.audio, song.fileName, undefined, song);
      const replacement = await updateSongIfFileMatches(
        song.id,
        song.fileName,
        song.source?.version,
        current => sameSongAudioRevision(current, song)
          ? applyLocalAudioReanalysis(current, rebuilt.analysis)
          : null,
      );
      if (!replacement) {
        const latest = await getSongs().catch(() => null);
        if (latest) {
          setSongs(latest);
          setActiveId(latest.find(row => row.id === song.id)?.id ?? latest[0]?.id ?? null);
        }
        setScreen('library');
        showToast('曲目在分析期间已被修改，请从曲库重新选择。', true);
        return;
      }
      setSongs(rows => rows.map(row => row.id === replacement.id ? replacement : row));
      showToast('旧曲目已从原音频升级为最新分析');
      enterSong(replacement.id);
    } catch (error) {
      enterSong(song.id);
      setMode('free');
      showToast(`${song.title}：${error instanceof Error ? error.message : '本地音频分析失败'}；已进入自由弹奏`, true);
    } finally {
      setLoading(null);
      importing.current = false;
    }
  };
  const changeMode = useCallback((value: PlayMode) => {
    setMode(value);
    setScore(EMPTY_SCORE);
    resetCueState();
  }, [resetCueState]);

  const persist = async (analysis: SongAnalysis) => {
    if (!selected) return;
    const updated = { ...selected, analysis };
    try { await saveSong(updated); setSongs(rows => rows.map(row => row.id === updated.id ? updated : row)); }
    catch (error) { showToast(error instanceof Error ? error.message : '保存失败', true); throw error; }
  };

  const editSegment = (segment: ChordSegment) => { setEditId(segment.id); setEditChord(segment.chord); setEditStart(segment.start.toFixed(2)); setEditEnd(segment.end.toFixed(2)); };
  const openScoreEditor = (segment?: ChordSegment) => {
    stopPlaybackImmediately();
    if (segment) editSegment(segment);
    setTab('score');
  };
  const openPerformance = () => {
    stopPlaybackImmediately();
    setTab('play');
  };
  const previewEditedSegment = async (segment: ChordSegment) => {
    if (!ready) { showToast('伴奏仍在载入，请稍后再试听。', true); return; }
    stopPlaybackImmediately();
    engine.setLoop(segment.start, segment.end);
    setLoop([segment.start, segment.end]);
    seek(segment.start);
    try {
      await runGuardedPlaybackStart(playbackStart.current, () => engine.unlock(), () => {
        engine.play(segment.start);
        setPlaying(engine.isPlaying());
      });
    } catch (error) {
      stopPlaybackImmediately();
      showToast(`试听失败：${error instanceof Error ? error.message : '声音无法启动'}`, true);
    }
  };
  const applyEdit = async () => {
    if (!selected) return;
    const index = selected.analysis.chords.findIndex(c => c.id === editId);
    if (index < 0) return;
    const chords = selected.analysis.chords;
    const start = Number(editStart); const end = Number(editEnd);
    if (!validateBoundaries(chords[index], start, end, selected.analysis.duration) || (index === 0 && start !== 0) || (index === chords.length - 1 && Math.abs(end - selected.analysis.duration) > .015) || (index > 0 && start - chords[index - 1].start < .12) || (index < chords.length - 1 && chords[index + 1].end - end < .12)) {
      showToast('时间不能越过相邻和弦；首段从 0 秒开始，末段保留歌曲结尾。', true); return;
    }
    const updated = replaceChordBoundary(chords, index, start, end).map((c, i) => i === index ? { ...c, chord: editChord, confidence: 1, edited: true } : c);
    try { await persist({ ...selected.analysis, chords: updated }); showToast('和弦修改已保存到本地'); } catch { /* persistence already reported */ }
  };

  const loopSegment = (segment?: ChordSegment) => {
    if (loop) { engine.setLoop(0, null); setLoop(null); return; }
    if (!selected) return;
    const part = segment ?? currentChord ?? selected.analysis.chords[0];
    if (!part) return;
    engine.setLoop(part.start, part.end); setLoop([part.start, part.end]); seek(part.start);
    showToast(`循环练习 ${formatTime(part.start)}–${formatTime(part.end)}`);
  };

  const exportScore = () => {
    if (!selected) return;
    const blob = new Blob([JSON.stringify({ version: 1, title: selected.title, artist: selected.artist, analysis: selected.analysis }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${selected.title}-弦外分析.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('分析结果已导出，音频文件不会包含在 JSON 中');
  };

  const shiftBeats = async (amount: number) => {
    if (!selected) return;
    try { await persist({ ...selected.analysis, beats: selected.analysis.beats.map(b => b + amount).filter(b => b >= 0 && b < selected.analysis.duration) }); showToast(`起拍已${amount > 0 ? '后移' : '前移'} ${Math.abs(amount).toFixed(2)} 秒`); } catch { /* handled */ }
  };
  const scaleBeats = async (factor: number) => {
    if (!selected) return;
    const a = selected.analysis;
    if (a.bpm * factor < 20 || a.bpm * factor > 300) { showToast('节奏已达到可调范围', true); return; }
    const beats = factor === .5 ? a.beats.filter((_, i) => i % 2 === 0) : a.beats.flatMap((beat, i) => i < a.beats.length - 1 ? [beat, (beat + a.beats[i + 1]) / 2] : [beat]);
    try { await persist({ ...a, bpm: a.bpm * factor, beats }); showToast('节拍密度已更新'); } catch { /* handled */ }
  };

  const deleteSelected = async () => {
    if (!selected) return;
    stopPlaybackImmediately();
    try { await removeSong(selected.id); const rest = songs.filter(s => s.id !== selected.id); setSongs(rest); setActiveId(rest[0]?.id ?? null); if (!rest.length) setScreen('library'); setDeleting(false); showToast('歌曲已从浏览器曲库移除，原始文件不受影响'); }
    catch (error) { showToast(error instanceof Error ? error.message : '移除失败', true); }
  };

  const palette = [...new Set(selected?.analysis.chords.filter(c => c.chord !== 'N').map(c => c.chord) ?? ['C', 'G', 'Am', 'F'])];
  const nextIndex = selected?.analysis.chords.findIndex(c => c.id === currentChord?.id) ?? -1;
  const upcoming = selected?.analysis.chords.slice(Math.max(0, nextIndex), Math.max(0, nextIndex) + 5) ?? [];
  const nearest = nearestBeat(selected?.analysis.beats ?? [], time);
  const total = score.perfect + score.good + score.missed;
  const accuracy = total ? Math.round((score.perfect + score.good) / total * 100) : 0;
  const editing = selected?.analysis.chords.find(c => c.id === editId);
  const filtered = songs.filter(song => `${song.title} ${song.artist}`.toLowerCase().includes(search.toLowerCase()));
  const highMatch = isHighMatch(total, accuracy, playing, mode);

  if (screen === 'library') return <div className="library-shell" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void onFiles(e.dataTransfer.files); }}>
    <input ref={inputRef} type="file" accept={MP3_FILE_ACCEPT} multiple hidden aria-label="导入本地 MP3" onChange={e => { if (e.target.files) void onFiles(e.target.files); }} />
    <LibraryView songs={songs} search={search} setSearch={setSearch} onPlay={id => void changeSong(id)} onImport={openAudioPicker} loading={loading} />
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}><span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;

if (selected && tab === 'play') return <ImmersivePlayer song={selected} chord={soundingChord} mode={mode} practiceCues={practiceCues} practiceRevision={practiceRevision} hitEvents={hitEvents} technique={technique} backingKind={backingKind} backingEnabled={backingEnabled} originalEnabled={originalEnabled} rhythmEnabled={rhythmEnabled} ready={ready} playing={playing} time={time} highMatch={highMatch} hit={hitCue} strumEvent={strumEvent} stringEvent={stringEvent} volumes={volumes} onMode={changeMode} onTechnique={setTechnique} onBacking={toggleBacking} onOriginal={toggleOriginal} onRhythm={() => { const next = !rhythmEnabled; engine.setVolumes({ metronome: next ? .55 : 0 }); setRhythmEnabled(next); wake(); }} onVolume={(kind, value) => setVolumes(previous => ({ ...previous, [kind]: value }))} onChord={setManualChord} onTogglePlay={() => void togglePlay()} onRestart={restartPractice} onSeek={seek} onBack={returnToLibrary} onEdit={() => openScoreEditor()} onStopPlayback={stopPlaybackImmediately} onWake={wake} onMute={mute} onPluck={pluck} getTime={getPracticeTime} isPlaying={isPracticePlaying} getJudgedCueIds={getJudgedCueIds} />;

  return <div className={`app-shell immersive-session ${tab === 'score' ? 'editing-session' : ''} ${highMatch ? 'high-match' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }} onDrop={(e: DragEvent) => { e.preventDefault(); setDragOver(false); void onFiles(e.dataTransfer.files); }}>
    <div className="ambient-reward" aria-hidden="true" />
    {highMatch && hitCue?.perfect && <div key={`edge-${hitCue.at}`} className="edge-hit-reward" aria-hidden="true" />}
    <input ref={inputRef} type="file" accept={MP3_FILE_ACCEPT} multiple hidden aria-label="导入本地 MP3" onChange={e => { if (e.target.files) void onFiles(e.target.files); }} />
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); openPerformance(); }}><span className="brand-icon"><AudioLines size={27} strokeWidth={1.7} /></span><span>弦外<small>STRING STUDIO</small></span></a>
      <button className="import-button" onClick={openAudioPicker} disabled={!!loading}><Plus size={17} />导入我的歌曲</button>
      <div className="sidebar-section-title">WORKSPACE</div>
      <button className={`nav-item ${tab === 'play' ? 'selected' : ''}`} onClick={openPerformance}><Guitar size={18} />演奏空间<span className="nav-dot" /></button>
      <button className={`nav-item ${tab === 'score' ? 'selected' : ''}`} onClick={() => openScoreEditor()}><SlidersHorizontal size={18} />和弦校正</button>
      <div className="library-heading"><span>我的曲库</span><span>{songs.length.toString().padStart(2, '0')}</span></div>
      <label className="library-search"><Search size={14} /><input aria-label="搜索曲库" placeholder="找一首想弹的歌" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="song-list">{filtered.map((song, index) => <button key={song.id} onClick={() => void changeSong(song.id)} className={`song-row ${activeId === song.id ? 'active' : ''}`}>
        <span className={`song-cover cover-${index % 3}`}>{index % 2 ? <span className="cover-sun" /> : <AudioLines size={22} />}</span>
        <span className="song-copy"><strong>{song.title}</strong><small>{song.artist}</small></span>{activeId === song.id && <span className={`equalizer ${playing ? 'moving' : ''}`}><i /><i /><i /></span>}
      </button>)}{!filtered.length && <div className="sidebar-empty">{loading ? '正在准备你的第一首歌…' : search ? '没有找到这首歌' : '把喜欢的歌，放进这里。'}</div>}</div>
      <div className="sidebar-bottom"><div className="local-badge"><ShieldCheck size={15} /><span>仅在你的电脑上</span><span className="live-dot" /></div><p>你的音乐、分析与每次练习<br />都留在本地。</p><button className="help-link" onClick={() => setHelp(true)}><CircleHelp size={15} />如何开始弹奏<ChevronRight size={14} /></button></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><button className="back-library" onClick={returnToLibrary}><ChevronRight size={17} />返回曲库</button><span className="session-brand"><AudioLines size={20} />弦外<span>只管此刻</span></span><div className="topbar-right"><button className="session-edit-link" onClick={() => tab === 'play' ? openScoreEditor() : openPerformance()}><PencilLine size={14} />{tab === 'play' ? '校正和弦' : '返回演奏'}</button><button className="icon-button" aria-label="操作指南" onClick={() => setHelp(true)}><CircleHelp size={18} /></button></div></header>

      <div className="workspace">
        <section className="page-heading"><div><div className="eyebrow">A LITTLE MUSIC, A LITTLE YOU.</div><h1>{tab === 'play' ? '把喜欢的歌，弹成自己的。' : '好听的下一步，由你来定。'}</h1><p>{tab === 'play' ? '拨动琴弦，让今天慢一点。' : '试听每一段，微调自动分析的和弦。'}</p></div><button className="secondary-button" onClick={openAudioPicker} disabled={!!loading}><Upload size={15} />导入音频</button></section>

        {loading && <div className="analysis-progress" role="status"><LoaderCircle size={19} className="spin" /><div><strong>正在分析 {loading.title}</strong><span>{loading.stage} · 音频仅在本机处理</span></div><div className="progress-meter"><i style={{ width: `${loading.progress > 1 ? loading.progress : loading.progress * 100}%` }} /></div><span>{Math.round(loading.progress > 1 ? loading.progress : loading.progress * 100)}%</span></div>}

        {selected ? <>
          <section className="track-header"><div className="track-art"><span /><AudioLines size={36} strokeWidth={1} /></div><div className="track-title"><div className="track-title-line"><h2>{selected.title}</h2>{selected.source?.preview && <span className="preview-badge">30 秒试听</span>}</div><p>{selected.artist}<span>·</span>{formatTime(selected.analysis.duration)}</p></div><div className="track-metadata"><div><strong>{Math.round(selected.analysis.bpm)}</strong><small>BPM · 估计</small></div><div><strong>{selected.analysis.key || '—'}</strong><small>调性 · 估计</small></div><div><strong>{palette.length}</strong><small>个和弦</small></div></div><button className="icon-button subtle" aria-label="移除当前歌曲" onClick={() => { stopPlaybackImmediately(); setDeleting(true); }}><Trash2 size={16} /></button></section>

          {tab === 'play' ? <>
            <div className="session-toolbar"><div className="segmented-control" aria-label="弹奏模式">{([{ id: 'easy', title: '旋律跟弹' }, { id: 'challenge', title: '旋律挑战' }, { id: 'free', title: '自由弹奏' }] as const).map(item => <button key={item.id} className={mode === item.id ? 'active' : ''} onClick={() => changeMode(item.id)}><span />{item.title}</button>)}</div><span className="mode-note">{mode === 'easy' ? '跟随逐音旋律 · 自动和弦' : mode === 'challenge' ? '自己换和弦 · 弹准目标弦' : '选一个和弦，随心拨弦'}</span><button className={`backing-toggle rhythm-toggle ${rhythmEnabled ? 'enabled' : ''}`} role="switch" aria-checked={rhythmEnabled} onClick={() => { const next = !rhythmEnabled; engine.setVolumes({ metronome: next ? .55 : 0 }); setRhythmEnabled(next); wake(); }}><span>鼓点 <strong>{rhythmEnabled ? '开' : '关'}</strong></span><span className="toggle-track"><i /></span></button><button className={`backing-toggle ${backingEnabled ? 'enabled' : ''}`} role="switch" aria-checked={backingEnabled} onClick={toggleBacking}><AudioLines size={16} /><span>旋律伴奏 <strong>{backingEnabled ? '开' : '关'}</strong></span><span className="toggle-track"><i /></span></button></div>

            <div className="performance-surface"><GuitarStage chord={soundingChord} technique={technique} onWake={wake} onPluck={pluck} onMute={mute} strumEvent={strumEvent} stringEvent={stringEvent} practice={{ cues: practiceCues, getTime: getPracticeTime, isPlaying: isPracticePlaying, getJudgedCueIds, hits: hitEvents, revision: practiceRevision }} />
            <div className="stage-hud chord-hud"><span>此刻和弦</span><strong>{soundingChord === 'N' ? '—' : soundingChord}</strong><small>{mode === 'easy' ? '跟着圆点，拨响它' : '选好和弦，随心弹'}</small><i /><span className="hud-instruction">鼠标左右扫弦<br />按住 · 拉开 · 松手</span></div>
            <div className="stage-hud score-hud"><span>{mode === 'free' ? '自由发挥' : '连续命中'}</span><strong>{mode === 'free' ? '∞' : score.combo.toString().padStart(2, '0')}</strong><small>{mode === 'free' ? '不计分，听自己的' : total ? `${accuracy}% 节奏匹配` : '等你的第一拍'}</small><i /><span className="hud-instruction">{highMatch ? '状态正好，继续保持' : '弹准节奏，点亮舞台'}</span></div>
            {highMatch && <div className="resonance-badge"><Sparkles size={15} />进入共鸣 · {accuracy}% 匹配度</div>}</div>

            <div className="technique-bar"><div className="technique-label"><Settings2 size={15} />拨奏手感</div><div className="technique-options">{TECHNIQUES.map(item => <button key={item.id} title={item.description} className={technique === item.id ? 'active' : ''} onClick={() => setTechnique(item.id)}><span className={`technique-symbol ${item.id}`} />{item.label}{technique === item.id && <Check size={12} />}</button>)}</div><span className="technique-tip">轻拉 · 松手 · 扫过 · 来回轮拨</span></div>

            <section className="follow-panel"><div className="section-caption"><div><span className="section-number">01</span><h3>{mode === 'free' ? '选一个和弦，随心弹' : '跟上这一段'}</h3><span className="small-label">{mode === 'easy' ? '自动和弦' : '手动和弦'}</span></div><button className="text-button" onClick={() => openScoreEditor(currentChord ?? undefined)}><PencilLine size={13} />校正和弦</button></div>
              {mode === 'easy' ? <div className="chord-flow">{upcoming.map((segment, index) => <div key={segment.id} className={`flow-chord ${index === 0 ? 'current' : ''}`}><span>{index === 0 ? '正在弹' : '接下来'}</span><strong>{segment.chord === 'N' ? '休止' : segment.chord}</strong><small>{formatTime(segment.start)} – {formatTime(segment.end)}</small>{index === 0 && <div className="chord-progress" style={{ width: `${Math.max(0, Math.min(100, (time - segment.start) / (segment.end - segment.start) * 100))}%` }} />}</div>)}{!upcoming.length && <div className="empty-chords">这一段还没有和弦，打开编辑器试着添加或校正。</div>}<div className="chord-flow-tail"><ChevronRight size={20} /></div></div> : <div className="chord-palette">{palette.map((chord, index) => <button key={chord} className={manualChord === chord ? 'current' : ''} onClick={() => { setManualChord(chord); wake(); }}><strong>{chord}</strong><kbd>{index < 8 ? index + 1 : '鼠标'}</kbd></button>)}<label className="all-chords-label">更多<select aria-label="选择任意和弦" value={manualChord} onChange={e => setManualChord(e.target.value)}>{ALL_CHORDS.filter(c => c !== 'N').map(c => <option key={c}>{c}</option>)}</select></label></div>}
              <div className="rhythm-row"><span className="rhythm-title">建议节奏<small>每拍下扫 · 简化编配</small></span><div className="beat-dots">{Array.from({ length: 8 }, (_, i) => <div key={i} className={playing && nearest && nearest.index % 8 === i ? 'on-beat' : ''}><ArrowDown size={20} /><span>{i % 4 + 1}</span></div>)}</div><div className="practice-score"><span className="score-number">{mode === 'free' ? '∞' : score.combo.toString().padStart(2, '0')}</span><div><strong>{mode === 'free' ? '自由发挥' : '连续命中'}</strong><small>{mode === 'free' ? '听见自己的节奏' : total ? `${accuracy}% 节奏准确率` : '等你的第一拍'}</small></div></div></div>
            </section>
            <div className="judgment-row"><span><Sparkles size={13} />{judgment}</span><span>{mode === 'easy' ? '轻松模式只评价节奏，不评价和弦选择' : mode === 'challenge' ? '同时评价和弦与节奏' : '自由模式不计分'}</span></div>
          </> : <section className="score-editor"><div className="section-caption"><div><span className="section-number">01</span><h3>听一听，再调一调</h3></div><div className="editor-actions"><button className="text-button" onClick={exportScore}><Download size={13} />导出分析</button></div></div>
            <div className="editor-notice"><Sparkles size={16} /><span>逐音旋律、节拍与和弦都由上传音频自动生成，无需另找琴谱。这里可试听并校正和弦初稿。</span></div>
            <div className="editor-wave"><Waveform values={selected.analysis.waveform} progress={time / selected.analysis.duration} /><div className="editor-timestamps"><span>0:00</span><span>{formatTime(selected.analysis.duration / 2)}</span><span>{formatTime(selected.analysis.duration)}</span></div></div>
            <div className="chord-timeline" aria-label="歌曲和弦时间轴">{selected.analysis.chords.map(segment => <button key={segment.id} style={{ flexGrow: segment.end - segment.start }} className={`${segment.confidence < .5 && !segment.edited ? 'uncertain' : ''} ${editId === segment.id ? 'selected' : ''} ${segment.edited ? 'edited' : ''}`} title={`${segment.chord} ${segment.start.toFixed(2)}–${segment.end.toFixed(2)}秒`} onClick={() => { editSegment(segment); seek(segment.start); }}><strong>{segment.chord === 'N' ? '休止' : segment.chord}</strong><small>{segment.start.toFixed(1)}s</small>{segment.edited && <Check size={10} />}</button>)}</div>
            <div className="timeline-legend"><span><i /> 自动分析</span><span><i className="uncertain" /> 建议确认</span><span><i className="edited" /> 已校正</span></div>
            {editing ? <div className="edit-form"><div className="edit-form-title"><PencilLine size={16} /><strong>编辑和弦片段</strong><span>{editing.edited ? '已人工校正' : `算法匹配强度 ${Math.round(editing.confidence * 100)}%（非准确率）`}</span></div><div className="edit-fields"><label>和弦<select aria-label="编辑和弦" value={editChord} onChange={e => setEditChord(e.target.value)}>{ALL_CHORDS.map(c => <option key={c} value={c}>{c === 'N' ? 'N · 休止 / 无和弦' : c}</option>)}</select></label><label>开始 / 秒<input type="number" aria-label="和弦开始秒数" step=".05" min="0" value={editStart} onChange={e => setEditStart(e.target.value)} /></label><label>结束 / 秒<input type="number" aria-label="和弦结束秒数" step=".05" min="0" value={editEnd} onChange={e => setEditEnd(e.target.value)} /></label><button className="secondary-button" onClick={() => void previewEditedSegment(editing)}><Repeat2 size={14} />循环试听</button><button className="primary-button" onClick={() => void applyEdit()}><Check size={14} />保存修改</button></div></div> : <div className="select-segment"><MousePointer2 size={17} />点击上方的和弦块，即可调整和弦和时间边界。</div>}
            <div className="beat-editor"><div><strong>节拍对齐</strong><small>跟原曲不一致时，先校正起拍与节拍密度。</small></div><button className="secondary-button" onClick={() => void shiftBeats(-.1)}>起拍 −0.1s</button><button className="secondary-button" onClick={() => void shiftBeats(.1)}>起拍 +0.1s</button><button className="secondary-button" onClick={() => void scaleBeats(.5)}>半速节拍</button><button className="secondary-button" onClick={() => void scaleBeats(2)}>双倍节拍</button></div>
            <div className="editor-footer"><span>{selected.analysis.algorithm}</span>{selected.originalAnalysis && <button className="text-button" onClick={() => { if (window.confirm('恢复最初的自动分析结果？当前手动修改会被替换。')) void persist(structuredClone(selected.originalAnalysis)).then(() => { setEditId(null); showToast('已恢复自动分析结果'); }).catch(() => {}); }}><RotateCcw size={13} />恢复分析初稿</button>}</div>
          </section>}

          <section className="transport"><div className="transport-seek"><Waveform values={selected.analysis.waveform} progress={time / selected.analysis.duration} /><input type="range" min="0" max={selected.analysis.duration} step=".01" aria-label="练习播放进度" value={Math.min(time, selected.analysis.duration)} onChange={e => seek(Number(e.target.value))} /><span className="playhead" style={{ left: `${time / selected.analysis.duration * 100}%` }} /></div><div className="transport-controls"><div className="play-controls"><button className="icon-button" aria-label="从头练习" onClick={() => seek(loop?.[0] ?? 0)}><RotateCcw size={17} /></button><button className="play-button" disabled={!ready} aria-label={playing ? '暂停练习' : '开始练习'} onClick={() => void togglePlay()}>{!ready ? <LoaderCircle size={21} className="spin" /> : playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><button className={`icon-button ${loop ? 'enabled' : ''}`} aria-label={loop ? '关闭循环' : '循环当前和弦'} onClick={() => loopSegment()}><Repeat2 size={18} /></button><span className="transport-time">{formatTime(time)}<span>/ {formatTime(selected.analysis.duration)}</span></span>{loop && <span className="loop-badge">循环 {formatTime(loop[0])}–{formatTime(loop[1])}</span>}</div><span className="silent-practice-note">{originalEnabled ? '原声开启 · 播放你导入的音频' : backingEnabled ? '纯器乐 · 自动和弦编配，非原版伴奏' : rhythmEnabled ? '仅节奏鼓点 · 和弦伴奏关闭' : '伴奏与鼓点关闭 · 只听见你拨出的声音'}</span><div className="mixer">{backingEnabled && <label><AudioLines size={15} /><span>伴奏</span><input aria-label="伴奏音量" type="range" min="0" max="1" step=".01" value={volumes.song} onChange={e => setVolumes(v => ({ ...v, song: Number(e.target.value) }))} /></label>}{originalEnabled && <label><Headphones size={15} /><span>原声</span><input aria-label="原声音量" type="range" min="0" max="1" step=".01" value={volumes.original} onChange={e => setVolumes(v => ({ ...v, original: Number(e.target.value) }))} /></label>}<label><Volume2 size={15} /><span>拨弦</span><input aria-label="吉他音量" type="range" min="0" max="1" step=".01" value={volumes.guitar} onChange={e => setVolumes(v => ({ ...v, guitar: Number(e.target.value) }))} /></label></div></div></section>
          <footer className="workspace-footer"><span><Headphones size={13} />戴上有线耳机，拨弦更跟手。</span>{selected.source && <a href={selected.source.url} target="_blank" rel="noreferrer">{selected.source.label}<ExternalLink size={12} /></a>}<span>MADE FOR YOUR LITTLE MOMENTS.</span></footer>
        </> : <div className="empty-state"><div className="empty-guitar"><Guitar size={68} strokeWidth={1} /></div><span className="eyebrow">YOUR FIRST ACOUSTIC SESSION</span><h2>今天，想弹哪一首？</h2><p>把 MP3 拖进来，我们帮你找到旋律、节奏和和弦。<br />你只需要用鼠标，轻轻拨响它。</p><button className="primary-button" disabled={!!loading} onClick={openAudioPicker}><Upload size={17} />选择本地 MP3</button><small>MP3 · 单首最长 10 分钟 · 100 MB 以内</small><div className="demo-songs">{demos.map(demo => <button disabled={!!loading} key={demo.id} onClick={() => void loadDemo(demo)}><Music2 size={17} /><div><strong>{demo.title}</strong><small>{demo.artist} · {demo.preview ? '30 秒官方试听' : '本地完整版'}</small></div><ChevronRight size={16} /></button>)}</div></div>}
      </div>
    </main>
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={17} /> : <CheckCircle2 size={17} />}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
    {dragOver && <div className="drop-overlay" onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }}><Upload size={44} /><h2>把喜欢的 MP3，放在这里。</h2><p>支持一次导入多首歌曲，文件不会上传到云端</p></div>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}><button className="modal-close icon-button" aria-label="关闭操作指南" onClick={() => setHelp(false)}><X size={20} /></button><span className="eyebrow">A SMALL GUIDE</span><h2 id="help-title">把鼠标，当成你的手。</h2><p>先点击播放，再跟随节拍拨响琴弦。也可以进入自由弹奏，随时试音。</p><div className="gesture-grid"><div><MousePointer2 size={22} /><strong>单弦拨奏</strong><p>点一下琴弦，或者按住轻轻拉开再松手。拉开越多，拨弦越有力。</p></div><div><ArrowDown size={22} /><strong>左右扫弦</strong><p>按住左键左右划过琴弦。快扫更明亮有力，慢扫能听到每根弦。</p></div><div><Repeat2 size={22} /><strong>轮拨与分解</strong><p>来回划过同一根弦可以轮拨；依次点不同琴弦就是分解和弦。</p></div><div><Keyboard size={22} /><strong>键盘弹奏</strong><p>A、S、D、F、G、H 对应从低到高六根弦；J、K 向两个方向扫弦。</p></div></div><div className="shortcut-row"><kbd>A–H</kbd> 六根弦 <kbd>J / K</kbd> 双向扫弦 <kbd>Space</kbd> 播放 / 暂停 <kbd>M</kbd> 止音 <kbd>1–8</kbd> 手动选和弦</div><div className="help-note">基础和弦自动分析不是专业扒谱；单点会重复提示低音弦，带箭头的波纹长条表示沿箭头方向扫过整组琴弦。导入的歌曲保存在当前浏览器，清除网站数据会清空曲库。</div><button className="primary-button" onClick={() => setHelp(false)}>开始我的演奏<ChevronRight size={16} /></button></section></div>}
    {deleting && <div className="modal-backdrop"><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">从曲库移除这首歌？</h2><p>“{selected?.title}”的本地缓存和手动校正会被移除。电脑上的原始音频不会改变；需要时可以再次导入。</p><div><button className="secondary-button" onClick={() => setDeleting(false)}>保留</button><button className="danger-button" onClick={() => void deleteSelected()}>移除歌曲</button></div></section></div>}
  </div>;
}
