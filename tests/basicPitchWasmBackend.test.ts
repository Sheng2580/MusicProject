import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ready: vi.fn(),
  setBackend: vi.fn(),
  setThreadsCount: vi.fn(),
  setWasmPaths: vi.fn(),
  transcribeGameMelody: vi.fn(),
}));

vi.mock('@tensorflow/tfjs', () => ({
  ready: mocks.ready,
  setBackend: mocks.setBackend,
}));

vi.mock('@tensorflow/tfjs-backend-wasm', () => ({
  setThreadsCount: mocks.setThreadsCount,
  setWasmPaths: mocks.setWasmPaths,
}));

vi.mock('../src/lib/gameTranscription', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/gameTranscription')>(),
  transcribeGameMelody: mocks.transcribeGameMelody,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.ready.mockResolvedValue(undefined);
  mocks.setBackend.mockResolvedValue(true);
});

describe('Basic Pitch TensorFlow WASM backend', () => {
  it('configures all WASM binaries and one worker thread before selecting the backend', async () => {
    const { initializeBasicPitchWasmBackend } = await import('../src/lib/melodyTranscription');

    await Promise.all([
      initializeBasicPitchWasmBackend(),
      initializeBasicPitchWasmBackend(),
    ]);

    expect(mocks.setWasmPaths).toHaveBeenCalledOnce();
    expect(mocks.setWasmPaths).toHaveBeenCalledWith({
      'tfjs-backend-wasm.wasm': expect.any(String),
      'tfjs-backend-wasm-simd.wasm': expect.any(String),
      'tfjs-backend-wasm-threaded-simd.wasm': expect.any(String),
    });
    expect(mocks.setThreadsCount).toHaveBeenCalledOnce();
    expect(mocks.setThreadsCount).toHaveBeenCalledWith(1);
    expect(mocks.setBackend).toHaveBeenCalledOnce();
    expect(mocks.setBackend).toHaveBeenCalledWith('wasm');
    expect(mocks.ready).toHaveBeenCalledOnce();

    expect(mocks.setWasmPaths.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setBackend.mock.invocationCallOrder[0]);
    expect(mocks.setThreadsCount.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setBackend.mock.invocationCallOrder[0]);
    expect(mocks.setBackend.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.ready.mock.invocationCallOrder[0]);
  });

  it('returns a successful GAME melody when Basic Pitch initialization fails', async () => {
    const gameMelody = Array.from({ length: 8 }, (_, index) => ({
      start: 3 + index * .2,
      duration: .12,
      midi: 60 + index,
      confidence: .9,
      strength: .8,
    }));
    mocks.transcribeGameMelody.mockResolvedValue(gameMelody);
    mocks.setBackend.mockRejectedValue(new Error('WASM unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { transcribeMelodyInWorker } = await import('../src/lib/melodyTranscription');

    const result = await transcribeMelodyInWorker(new Float32Array(5 * 44_100));

    expect(result).toEqual(gameMelody);
    expect(mocks.setBackend).toHaveBeenCalledWith('wasm');
    expect(warning).toHaveBeenCalledWith(
      'Basic Pitch 器乐空段补全失败，保留 GAME 歌声转录结果。',
      expect.objectContaining({ message: 'WASM unavailable' }),
    );
  });
});
