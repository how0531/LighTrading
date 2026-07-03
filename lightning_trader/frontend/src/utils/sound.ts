/**
 * sound.ts — 下單/刪單等操作音效的共用 helper
 *
 * 取代散落各處的 `new Audio(...)` 樣板。瀏覽器音效政策（未互動前不能播）
 * 與測試環境（jsdom 沒實作 play）都靜默處理，音效永遠不該讓交易流程出錯。
 */
export type SoundName = 'order_placed' | 'cancel_order' | 'order_replaced';

export function playSound(name: SoundName, volume = 0.5): void {
  try {
    const audio = new Audio(`/sounds/${name}.mp3`);
    audio.volume = volume;
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => { /* 瀏覽器音效政策：未互動前拒播，靜默 */ });
    }
  } catch { /* noop：無音效裝置 / 測試環境 */ }
}
