import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Headphones, Keyboard, LoaderCircle, Pause, PencilLine, Play, RotateCcw, Settings2, Volume2, X } from 'lucide-react';
import GuitarStage from './GuitarStage';
import { ALL_CHORDS } from './lib/audioEngine';
import type { GuitarTechnique } from './lib/audioEngine';
import type { BackingKind } from './lib/playbackTrack';
import type { PlayMode, PracticeCue, PracticeHit, SongRecord, StrumDirection } from './types';
import { formatTime } from './lib/game';

interface Props {
  song: SongRecord; chord: string; mode: PlayMode; technique: GuitarTechnique;
  practiceCues: PracticeCue[];
  backingKind: BackingKind | null; backingEnabled: boolean; originalEnabled: boolean; rhythmEnabled: boolean; ready: boolean; playing: boolean; time: number;
  highMatch: boolean; hit: PracticeHit | null; hitEvents: PracticeHit[]; practiceRevision: number;
  strumEvent: { at: number; direction: StrumDirection } | null;
  stringEvent: { at: number; index: number } | null;
  volumes: { song: number; original: number; guitar: number; metronome: number };
  onMode: (mode: PlayMode) => void; onTechnique: (value: GuitarTechnique) => void;
  onBacking: () => void; onOriginal: () => void; onRhythm: () => void;
  onVolume: (kind: 'song' | 'original' | 'guitar', value: number) => void;
  onChord: (chord: string) => void; onTogglePlay: () => void; onRestart: () => void; onSeek: (time: number) => void;
  onBack: () => void; onEdit: () => void; onStopPlayback: () => void; onWake: () => void; onMute: () => void;
  onPluck: (index: number, velocity: number, direction: StrumDirection, position: number) => void;
  getTime: () => number; isPlaying: () => boolean; getJudgedCueIds: () => ReadonlySet<string>;
}

export default function ImmersivePlayer(props: Props) {
  const [settings, setSettings] = useState(false);
  const [chrome, setChrome] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const lastReveal = useRef(0);
  const playingRef = useRef(props.playing); playingRef.current = props.playing;
  const reveal = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (playingRef.current) setChrome(false); }, 1800);
  }, []);
  useEffect(() => { reveal(); return () => { if (hideTimer.current) clearTimeout(hideTimer.current); }; }, [props.playing, reveal]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSettings(false); reveal(); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [reveal]);
  useEffect(() => {
    if (!settings) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, [settings]);
  const showChrome = chrome || !props.playing || settings;
  const palette = [...new Set([...props.song.analysis.chords.filter(c => c.chord !== 'N').map(c => c.chord), 'C', 'G', 'Am', 'F'])].slice(0, 8);

  return <main className={`pure-performance ${props.highMatch ? 'high-match' : ''}`} onPointerMove={e => {
    if ((e.clientY < 64 || e.clientY > window.innerHeight - 82) && performance.now() - lastReveal.current > 300) { lastReveal.current = performance.now(); reveal(); }
  }}>
    <GuitarStage chord={props.chord} technique={props.technique} onWake={props.onWake} onPluck={props.onPluck} onMute={props.onMute} strumEvent={props.strumEvent} stringEvent={props.stringEvent} practice={{ cues: props.mode === 'free' ? [] : props.practiceCues, getTime: props.getTime, isPlaying: props.isPlaying, getJudgedCueIds: props.getJudgedCueIds, hits: props.hitEvents, revision: props.practiceRevision }} />
    <div className="ambient-reward" aria-hidden="true" />
    {props.highMatch && props.hit?.perfect && <div key={`edge-${props.hit.at}`} className="edge-hit-reward" aria-hidden="true" />}

    <div className={`pure-chrome ${showChrome ? 'shown' : ''}`} inert={!showChrome || settings} aria-hidden={!showChrome || settings}>
      <header className="pure-top"><button aria-label="返回曲库" title="返回曲库" onClick={props.onBack}><ChevronRight size={20} /></button><span>{props.song.title}</span><div className="pure-top-actions"><button aria-label="重新开始" title="重新开始" onClick={props.onRestart}><RotateCcw size={19} /></button><button aria-label="演奏设置" title="演奏设置" onClick={() => { props.onStopPlayback(); setSettings(true); }}><Settings2 size={20} /></button></div></header>
      <div className="pure-bottom">{props.mode !== 'easy' && <div className="pure-chord-options">{palette.map(chord => <button key={chord} className={props.chord === chord ? 'active' : ''} onClick={() => props.onChord(chord)}>{chord}</button>)}</div>}<button className="pure-play" aria-label={props.playing ? '暂停练习' : '开始练习'} disabled={!props.ready} onClick={props.onTogglePlay}>{!props.ready ? <LoaderCircle size={20} className="spin" /> : props.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>{!props.playing && <small>A S D F G H 六根弦 · J / K 双向扫弦 · 空格播放</small>}</div>
    </div>

    {settings && <div className="pure-settings-backdrop" onClick={() => setSettings(false)}><aside ref={settingsRef} className="pure-settings" role="dialog" aria-modal="true" aria-label="演奏设置" onClick={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key !== 'Tab') return;
      const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select, input, [tabindex="0"]')];
      const first = controls[0]; const last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}><div className="pure-settings-heading"><h2>演奏设置</h2><button aria-label="关闭设置" onClick={() => setSettings(false)}><X size={20} /></button></div><p className="settings-song-name">{props.song.title}<small>{props.song.artist}{props.song.source ? props.song.source.preview ? ' · 30 秒分析样本' : ' · 完整曲目' : ''}</small></p>
      <label className="settings-field">弹奏模式<select aria-label="弹奏模式" value={props.mode} onChange={e => props.onMode(e.target.value as PlayMode)}><option value="easy">旋律跟弹 · 自动和弦</option><option value="challenge">旋律挑战 · 手动换和弦</option><option value="free">自由弹奏 · 不计分</option></select></label>
      <div className="settings-field">旋律提示<small className="settings-speed-hint">完整显示自动识别的每个起音，不省略节拍</small></div>
      <label className="settings-field">拨弦音色<select aria-label="拨弦音色" value={props.technique} onChange={e => props.onTechnique(e.target.value as GuitarTechnique)}><option value="pick">拨片 · 清亮</option><option value="finger">指腹 · 温暖</option><option value="muted">闷音 · 短促</option><option value="harmonic">泛音模拟 · 轻盈</option></select></label>
      {props.mode !== 'easy' && <label className="settings-field">当前和弦<select value={props.chord} aria-label="当前和弦" onChange={e => props.onChord(e.target.value)}>{ALL_CHORDS.filter(c => c !== 'N').map(c => <option key={c}>{c}</option>)}</select></label>}
      <button className={`settings-switch ${props.backingEnabled ? 'on' : ''}`} role="switch" aria-checked={props.backingEnabled} onClick={props.onBacking}><span>无人声伴奏<small>{props.backingKind === 'separated' ? '原曲分离的完整器乐轨' : '根据自动分析在本机生成'}</small></span><i /></button>
      <button className={`settings-switch ${props.originalEnabled ? 'on' : ''}`} role="switch" aria-checked={props.originalEnabled} onClick={props.onOriginal}><span>原声音轨<small>当前曲目的原始完整录音</small></span><i /></button>
      <button className={`settings-switch ${props.rhythmEnabled ? 'on' : ''}`} role="switch" aria-checked={props.rhythmEnabled} onClick={props.onRhythm}><span>节奏鼓点<small>独立开关，与伴奏无关</small></span><i /></button>
      <label className="settings-volume"><Volume2 size={15} />拨弦音量<input aria-label="拨弦音量" type="range" min="0" max="1" step=".01" value={props.volumes.guitar} onChange={e => props.onVolume('guitar', Number(e.target.value))} /></label>
      {props.backingEnabled && <label className="settings-volume"><Volume2 size={15} />伴奏音量<input aria-label="伴奏音量" type="range" min="0" max="1" step=".01" value={props.volumes.song} onChange={e => props.onVolume('song', Number(e.target.value))} /></label>}
      {props.originalEnabled && <label className="settings-volume"><Headphones size={15} />原声音量<input aria-label="原声音量" type="range" min="0" max="1" step=".01" value={props.volumes.original} onChange={e => props.onVolume('original', Number(e.target.value))} /></label>}
      <div className="settings-progress"><span>{formatTime(props.time)} / {formatTime(props.song.analysis.duration)}</span><input aria-label="练习播放进度" type="range" min="0" max={props.song.analysis.duration} step=".01" value={props.time} onChange={e => props.onSeek(Number(e.target.value))} /></div>
      <button className="settings-edit-score" onClick={props.onEdit}><PencilLine size={15} />校正自动分析的和弦<ChevronRight size={15} /></button><p className="settings-note"><Keyboard size={13} /> A / S / D / F / G / H 对应从低到高六根弦。练习中 J / K 只拨当前提示；自由模式可完整扫弦。</p><button className="settings-done" onClick={() => setSettings(false)}>回到琴弦</button>
    </aside></div>}
  </main>;
}
