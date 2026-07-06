/**
 * workingOrders.ts — 掛單查找表工廠
 *
 * 從 useDOMLogic 的 workingBuyMap / workingSellMap 重複程式碼抽出：
 * 給定委託清單與方向，建出「價格 key（price*100 四捨五入）→ 未成交量」的 Map，
 * 供 DOM ladder 每一列 O(1) 查掛單量。
 */
import type { WorkingOrder } from '../contexts/TradingContext';
import { symbolMatches } from './instrument';

export function buildWorkingOrderMap(
  orders: WorkingOrder[],
  targetSymbol: string,
  action: 'Buy' | 'Sell',
): Map<number, number> {
  const m = new Map<number, number>();
  if (!targetSymbol) return m;
  for (const o of orders) {
    if (o.action !== action || !symbolMatches(targetSymbol, o.symbol)) continue;
    const key = Math.round(o.price * 100);
    m.set(key, (m.get(key) || 0) + (o.qty - o.filled_qty));
  }
  return m;
}
