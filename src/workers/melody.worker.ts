import { transcribeMelodyInWorker } from '../lib/melodyTranscription';

self.onmessage = async (event: MessageEvent<{ samples: Float32Array }>) => {
  try {
    const melody = await transcribeMelodyInWorker(event.data.samples, progress => {
      self.postMessage({ type: 'progress', progress });
    });
    self.postMessage({ type: 'result', melody });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '逐音旋律识别失败。',
    });
  }
};
