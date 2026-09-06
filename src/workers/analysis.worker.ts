import { analyzeSamples } from '../lib/musicAnalysis';

self.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  try {
    const analysis = analyzeSamples(event.data.samples, event.data.sampleRate, progress => {
      self.postMessage({ type: 'progress', progress });
    });
    self.postMessage({ type: 'result', analysis });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '音频分析失败。' });
  }
};
