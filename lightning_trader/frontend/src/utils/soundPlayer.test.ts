/**
 * soundPlayer 測試
 *
 * soundPlayer 在 module level 快取了 AudioContext，所以每個 test 用
 * vi.resetModules + 動態 import 拿一個全新的 module instance。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let oscMock: any;
let gainMock: any;
let ctxMock: any;

beforeEach(() => {
  vi.resetModules();
  oscMock = {
    type: '',
    frequency: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(), stop: vi.fn(),
  };
  gainMock = {
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  // osc.connect(gain).connect(ctx.destination) 的 chain
  oscMock.connect.mockReturnValue(gainMock);
  ctxMock = {
    currentTime: 0,
    state: 'running',
    resume: vi.fn(),
    createOscillator: vi.fn(() => oscMock),
    createGain: vi.fn(() => gainMock),
    destination: {},
  };
  // 必須是 constructor，不能用 arrow function — `new AudioContext()` 才能正常 invoke
  (window as any).AudioContext = function AudioContextMock(this: any) { return ctxMock; };
});

async function loadPlayer() {
  return await import('./soundPlayer');
}

describe('soundPlayer', () => {
  it('fill event creates an oscillator', async () => {
    const { playSound } = await loadPlayer();
    playSound('fill', 0.5);
    expect(ctxMock.createOscillator).toHaveBeenCalled();
    expect(oscMock.start).toHaveBeenCalled();
    expect(oscMock.stop).toHaveBeenCalled();
  });

  it('alert event creates two oscillators (double beep)', async () => {
    vi.useFakeTimers();
    const { playSound } = await loadPlayer();
    playSound('alert', 0.8);
    expect(ctxMock.createOscillator).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(ctxMock.createOscillator).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('disconnect event creates three oscillators (triple beep)', async () => {
    vi.useFakeTimers();
    const { playSound } = await loadPlayer();
    playSound('disconnect', 0.6);
    expect(ctxMock.createOscillator).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(ctxMock.createOscillator).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(300);
    expect(ctxMock.createOscillator).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('smart_trigger uses chirp (frequency ramp)', async () => {
    const { playSound } = await loadPlayer();
    playSound('smart_trigger', 0.5);
    expect(oscMock.frequency.exponentialRampToValueAtTime).toHaveBeenCalled();
  });

  it('unknown event still produces a neutral beep without crash', async () => {
    const { playSound } = await loadPlayer();
    expect(() => playSound('???', 0.5)).not.toThrow();
    expect(ctxMock.createOscillator).toHaveBeenCalled();
  });

  it('extreme volume does not throw', async () => {
    const { playSound } = await loadPlayer();
    expect(() => playSound('fill', 5.0)).not.toThrow();
    expect(() => playSound('fill', -1.0)).not.toThrow();
  });

  it('unlockAudio calls resume when suspended', async () => {
    ctxMock.state = 'suspended';
    const { unlockAudio, playSound } = await loadPlayer();
    // 先觸發一次 playSound 以建立內部 audioCtx
    playSound('fill', 0.5);
    unlockAudio();
    expect(ctxMock.resume).toHaveBeenCalled();
  });
});
