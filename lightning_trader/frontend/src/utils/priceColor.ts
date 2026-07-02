/**
 * priceColor.ts — 漲跌方向顏色單一真相源（架構整頓去重）
 *
 * 台灣慣例：紅漲、綠跌、平盤灰。原本散在多個面板的 `text-red-400`/
 * `text-emerald-400` 字面改走這裡。
 *
 * 注意（Tailwind 4 JIT）：常數必須是「完整 class 字面字串」，不可動態拼接
 * （例如 `text-${x}-400`），否則 build 時會被 purge 掉。
 */

export const UP_COLOR = 'text-red-400';      // 漲 / 外盤（主動買）
export const DOWN_COLOR = 'text-emerald-400'; // 跌 / 內盤（主動賣）
export const FLAT_COLOR = 'text-slate-400';   // 平盤 / 無方向

/** 依漲跌量回傳文字顏色 class（>0 紅、<0 綠、=0 灰）。 */
export function priceColor(delta: number): string {
  if (delta > 0) return UP_COLOR;
  if (delta < 0) return DOWN_COLOR;
  return FLAT_COLOR;
}
