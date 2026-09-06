import { ArrowUpRight, AudioLines, ChevronRight, Headphones, Plus, Search, ShieldCheck, Upload } from 'lucide-react';
import type { AnalysisProgress, SongRecord } from './types';
import { formatTime } from './lib/game';
import { highResolutionCover } from './lib/songMetadata';

interface Props {
  songs: SongRecord[];
  search: string;
  setSearch: (value: string) => void;
  onPlay: (id: string) => void;
  onImport: () => void;
  loading: (AnalysisProgress & { title: string }) | null;
}

export default function LibraryView({ songs, search, setSearch, onPlay, onImport, loading }: Props) {
  const filtered = songs.filter(song => `${song.title} ${song.artist}`.toLowerCase().includes(search.toLowerCase()));
  return <main className="library-page">
    <header className="library-top"><a className="library-brand" href="#" aria-label="弦外曲库"><AudioLines size={25} /><strong>弦外</strong><span>STRING STUDIO</span></a><span className="library-local"><ShieldCheck size={14} />音乐留在本机</span></header>
    <section className="library-hero"><div><span className="library-kicker">SIX STRINGS. YOUR MOMENT.</span><h1>留一点时间，<br /><em>给喜欢的旋律。</em></h1><p>选一首歌，把鼠标当成你的手。<br />没有歌词，没有喧闹，只有你和六根弦。</p></div><div className="library-illustration" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <i key={i} style={{ top: `${23 + i * 11}%` }} />)}<span className="illustration-note one">G</span><span className="illustration-note two">Am</span><span className="illustration-note three">C</span><span className="illustration-caption">a little music, a little you.</span></div></section>
    <section className="library-collection"><div className="library-section-head"><div><h2>我的曲库 <span>{songs.length.toString().padStart(2, '0')}</span></h2><p>选好之后，进入独立的沉浸演奏空间。</p></div><label className="library-search-box"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="找一首想弹的歌" aria-label="搜索曲库" /></label></div>
      {loading && <div className="library-progress" role="status"><AudioLines size={20} /><div><strong>正在分析 · {loading.title}</strong><span>{loading.stage}</span></div><progress max="1" value={loading.progress} /><span>{Math.round(loading.progress * 100)}%</span></div>}
      <div className="library-grid">{filtered.map((song) => {
        const fallbackCover = song.cover || '/default-cover.svg';
        const displayCover = highResolutionCover(fallbackCover);
        return <button key={song.id} className="library-song-card" onClick={() => onPlay(song.id)}><div className="library-card-art"><span className="card-preview">{song.source ? song.source.preview ? '30 秒分析样本' : '完整曲目' : '本地音频'}</span><img className="song-cover" src={displayCover} alt={`${song.title}封面`} loading="lazy" referrerPolicy="no-referrer" onError={e => {
          if (displayCover !== fallbackCover && e.currentTarget.src !== fallbackCover) e.currentTarget.src = fallbackCover;
          else if (!e.currentTarget.src.endsWith('/default-cover.svg')) e.currentTarget.src = '/default-cover.svg';
        }} /><span className="card-enter"><ArrowUpRight size={23} /></span></div><div className="library-card-info"><div><h3>{song.title}</h3><p>{song.artist}</p></div><span>{formatTime(song.analysis.duration)}</span></div><div className="library-card-footer"><span>{song.analysis.bpm ? `${Math.round(song.analysis.bpm)} BPM · 估计` : '自由节奏'}<i />{song.analysis.chords.length} 段和弦初稿</span><span>去弹奏<ChevronRight size={14} /></span></div></button>;
      })}<button className="library-import-card" onClick={onImport} disabled={!!loading}><span><Plus size={27} strokeWidth={1.3} /></span><h3>把你的歌放进来</h3><p>上传一首完整 MP3<br />自动生成逐音旋律、节奏与和弦</p><small><Upload size={13} />仅需 MP3</small></button></div>
      {!filtered.length && search && <p className="library-no-results">没有找到这首歌，换个名字试试。</p>}
    </section>
    <footer className="library-footer"><span><Headphones size={15} />有线耳机，会让每一次拨弦更跟手。</span><span>MP3 最多 10 分钟 / 100 MB · 音频留在本机 · 封面查询仅使用歌名与歌手</span></footer>
  </main>;
}
