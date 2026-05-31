/**
 * soundPlayer.ts — Web Audio API 合成 beep
 *
 * 設計理念：不依賴外部 wav 檔（部署時少一份資源 + Docker frontend 容器不用塞檔）。
 * 用 OscillatorNode 直接合成不同頻率/長度的短音，足以區分 6 個事件類型：
 *
 *   fill          — 高音清脆「叮」（成交）
 *   order_placed  — 中音短促（送單）
 *   cancel        — 低音弱促（撤單）
 *   smart_trigger — 上行 chirp（智慧單觸發）
 *   alert         — 兩短高音（風控警告，不可靜音）
 *   disconnect    — 三低音長音（連線中斷，不可靜音）
 */

type SoundEvent =
  | 'fill' | 'order_placed' | 'cancel'
  | 'smart_trigger' | 'alert' | 'disconnect';

let audioCtx: AudioContext | null = null;

function ctx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioCtx;
}

// 瀏覽器要求使用者互動後才能啟動 AudioContext；
// 第一次點任何地方就呼叫一次以解鎖。
export function unlockAudio(): void {
  try {
    const c = ctx();
    if (c.state === 'suspended') void c.resume();
  } catch { /* noop */ }
}

function beep(freq: number, durationMs: number, volume: number, type: OscillatorType = 'sine'): void {
  try {
    const c = ctx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // 平滑 attack/release 避免爆音
    const now = c.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.005);
    gain.gain.linearRampToValueAtTime(0, now + durationMs / 1000);
    osc.connect(gain).connect(c.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  } catch (e) {
    console.warn('[sound] beep failed', e);
  }
}

function chirp(fromFreq: number, toFreq: number, durationMs: number, volume: number): void {
  try {
    const c = ctx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    const now = c.currentTime;
    osc.frequency.setValueAtTime(fromFreq, now);
    osc.frequency.exponentialRampToValueAtTime(toFreq, now + durationMs / 1000);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.005);
    gain.gain.linearRampToValueAtTime(0, now + durationMs / 1000);
    osc.connect(gain).connect(c.destination);
    osc.start(now);
    osc.stop(now + durationMs / 1000 + 0.02);
  } catch { /* noop */ }
}

export function playSound(event: string, volume = 0.5): void {
  const v = Math.max(0, Math.min(1, volume));
  switch (event as SoundEvent) {
    case 'fill':         beep(880, 120, v * 0.6, 'triangle'); break;
    case 'order_placed': beep(660, 80,  v * 0.4, 'sine');     break;
    case 'cancel':       beep(330, 100, v * 0.4, 'sine');     break;
    case 'smart_trigger': chirp(440, 1100, 220, v * 0.7);     break;
    case 'alert':
      beep(1200, 100, v * 0.8, 'square');
      setTimeout(() => beep(1200, 100, v * 0.8, 'square'), 150);
      break;
    case 'disconnect':
      beep(250, 200, v * 0.6, 'sawtooth');
      setTimeout(() => beep(220, 200, v * 0.6, 'sawtooth'), 250);
      setTimeout(() => beep(180, 350, v * 0.6, 'sawtooth'), 500);
      break;
    default:
      // 未知事件 → 中性 beep 讓人發現
      beep(500, 60, v * 0.3);
  }
}
