/**
 * sound.ts — 下單/刪單等操作音效的共用 helper
 *
 * 取代散落各處的 `new Audio(...)` 樣板。瀏覽器音效政策（未互動前不能播）
 * 與測試環境（jsdom 沒實作 play）都靜默處理，音效永遠不該讓交易流程出錯。
 *
 * 音檔位於 public/sounds/*.wav（純合成短嗶聲，repo 內建，不會 404）。
 * 開/關與音量由 SettingsContext（notifications.sound）經 configureSound 注入，
 * util 本身保持純模組、不讀 localStorage。
 */
export type SoundName = 'order_placed' | 'cancel_order' | 'order_replaced' | 'fill' | 'risk_halt';

interface SoundConfig {
  enabled: boolean;
  volume: number; // 0–1
}

// 預設與 SettingsContext DEFAULT_SETTINGS.notifications.sound 一致
let soundConfig: SoundConfig = { enabled: true, volume: 0.6 };

/** SettingsProvider 在設定變更時呼叫，注入音效開關/音量（模組層級，免 context 穿透） */
export function configureSound(cfg: Partial<SoundConfig>): void {
  soundConfig = { ...soundConfig, ...cfg };
}

export function playSound(name: SoundName, volume?: number): void {
  if (!soundConfig.enabled) return;
  try {
    const audio = new Audio(`/sounds/${name}.wav`);
    audio.volume = Math.min(1, Math.max(0, volume ?? soundConfig.volume));
    if (import.meta.env.DEV) {
      // DEV 守門：音檔載入失敗（404 / 格式不支援）要看得到，避免靜默 regress
      audio.addEventListener('error', () => {
        console.warn(`[sound] 音效載入失敗：/sounds/${name}.wav（檔案缺失或格式不支援）`);
      });
    }
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => { /* 瀏覽器音效政策：未互動前拒播，靜默 */ });
    }
  } catch { /* noop：無音效裝置 / 測試環境 */ }
}
