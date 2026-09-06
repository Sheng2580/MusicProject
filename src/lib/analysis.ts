import type { AnalysisProgress, SongAnalysis } from '../types';
import { ANALYSIS_SAMPLE_RATE, MAX_AUDIO_DURATION } from './musicAnalysis';
import { MELODY_MODEL_SAMPLE_RATE, MELODY_TRANSCRIPTION_ALGORITHM, transcribeMelody } from './melodyTranscription';

const MAX_FILE_BYTES = 100 * 1024 * 1024;

type WorkerMessage =
  | { type: 'progress'; progress: AnalysisProgress }
  | { type: 'result'; analysis: SongAnalysis }
  | { type: 'error'; message: string };

interface AnalysisOptions { melody?: boolean }

/** Decode locally, then analyse harmony and the playable lead line without uploading audio. */
export async function analyzeAudio(blob: Blob, onProgress?: (progress: AnalysisProgress) => void, options: AnalysisOptions = {}): Promise<SongAnalysis> {
  let reportedProgress = 0;
  const reportProgress = (progress: number, stage: string) => {
    const finiteProgress = Number.isFinite(progress) ? progress : reportedProgress;
    reportedProgress = Math.min(1, Math.max(reportedProgress, finiteProgress));
    onProgress?.({ progress: reportedProgress, stage });
  };
  if (!blob.size) throw new Error('音频文件为空，请重新选择。');
  if (blob.size > MAX_FILE_BYTES) throw new Error('音频文件不能超过 100 MB，请先裁剪或压缩。');
  if (typeof AudioContext === 'undefined' || typeof OfflineAudioContext === 'undefined' || typeof Worker === 'undefined') {
    throw new Error('当前浏览器不支持本地音频分析，请使用最新版 Chrome、Edge 或 Safari。');
  }
  reportProgress(0.02, '正在读取音频文件…');
  const encoded = await blob.arrayBuffer();
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    reportProgress(0.07, '正在解码音频…');
    decoded = await context.decodeAudioData(encoded);
  } catch {
    throw new Error('无法解码此音频。请确认选择的是有效 MP3 文件，或尝试使用最新版浏览器。');
  } finally {
    await context.close().catch(() => undefined);
  }
  if (decoded.duration < 0.25) throw new Error('音频太短，请选择至少 0.25 秒的音频。');
  if (decoded.duration > MAX_AUDIO_DURATION) throw new Error('请使用 10 分钟以内的音频，或先裁剪需要练习的片段。');
  reportProgress(0.13, '正在转换为本地分析采样…');
  const targetSampleRate = options.melody === false ? ANALYSIS_SAMPLE_RATE : MELODY_MODEL_SAMPLE_RATE;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetSampleRate), targetSampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  let samples: Float32Array;
  try {
    const mono = await offline.startRendering();
    samples = mono.getChannelData(0).slice();
  } catch {
    throw new Error('音频转换失败，请尝试较短的音频片段。');
  } finally {
    source.disconnect();
    source.buffer = null;
  }
  const analysis = await new Promise<SongAnalysis>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(new Error('无法启动音频分析，请刷新页面后重试。'));
      return;
    }
    const timeout = globalThis.setTimeout(() => finish(new Error('音频分析超时，请尝试较短的音频片段。')), 120_000);
    let settled = false;
    function finish(error?: Error, analysis?: SongAnalysis) {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error);
      else if (analysis) resolve(analysis);
    }
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'progress') reportProgress(.13 + message.progress.progress * .34, message.progress.stage);
      else if (message.type === 'result') {
        reportProgress(.47, '节拍与和弦分析完成');
        finish(undefined, message.analysis);
      }
      else if (message.type === 'error') finish(new Error(message.message));
    };
    worker.onerror = () => finish(new Error('音频分析遇到错误，请重试或选择较短的音频片段。'));
    worker.onmessageerror = () => finish(new Error('无法读取音频分析结果，请重试。'));
    try {
      worker.postMessage({ samples: options.melody === false ? samples : samples.slice(), sampleRate: targetSampleRate }, options.melody === false ? [samples.buffer] : []);
    } catch {
      finish(new Error('无法传输音频数据，请重试。'));
    }
  });
  if (options.melody === false) {
    reportProgress(1, '本地分析完成');
    return analysis;
  }
  reportProgress(.49, '正在识别逐音主旋律…');
  let melody: SongAnalysis['melody'];
  try {
    melody = await transcribeMelody(samples, progress => reportProgress(
      .49 + progress * .49,
      `正在识别逐音主旋律… ${Math.round(progress * 100)}%`,
    ));
  } catch (error) {
    throw new Error('逐音旋律识别失败，请刷新后重试或选择较短的音频。', { cause: error });
  }
  if (melody.length < 8) throw new Error('没有识别到足够的连续旋律，请确认音频中有清晰的主奏或人声。');
  const result = {
    ...analysis,
    melody,
    algorithm: `${analysis.algorithm} / ${MELODY_TRANSCRIPTION_ALGORITHM}`,
  };
  reportProgress(1, '本地逐音分析完成');
  return result;
}
