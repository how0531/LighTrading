/**
 * priceAlerts.ts — 純函式 cross-detection
 *
 * 給定 prev / curr 兩個價格與一個 alert，判斷是否「剛剛穿越」。
 * 抽出來方便獨立測試（無 React、無 SettingsContext）。
 *
 * - op='above' 穿越條件：prev < price 且 curr >= price
 * - op='below' 穿越條件：prev > price 且 curr <= price
 * - prev 為 0（沒看過該 symbol 報價）→ 不算穿越，只記第一個觀測值
 * - 已 triggered 過的 alert（triggeredAt 有值）跳過
 * - disabled 的 alert 跳過
 */
import type { PriceAlert } from '../contexts/SettingsContext';

export function shouldTrigger(alert: PriceAlert, prev: number, curr: number): boolean {
  if (!alert.enabled) return false;
  if (alert.triggeredAt && alert.triggeredAt > 0) return false;
  if (!(prev > 0) || !(curr > 0)) return false;
  if (alert.op === 'above') return prev < alert.price && curr >= alert.price;
  if (alert.op === 'below') return prev > alert.price && curr <= alert.price;
  return false;
}

/** 一次更新一批 alerts 對應某個 symbol 的 prev/curr，回觸發的 id 清單。 */
export function findTriggered(
  alerts: PriceAlert[],
  symbol: string,
  prev: number,
  curr: number,
): string[] {
  const sym = (symbol || '').toUpperCase();
  return alerts
    .filter((a) => a.symbol.toUpperCase() === sym && shouldTrigger(a, prev, curr))
    .map((a) => a.id);
}
