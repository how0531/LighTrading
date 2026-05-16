/**
 * positionContext.ts — 從 fills + smart orders 推導「持倉脈絡」純函式
 *
 * 痛點來源：
 *  - Alex 動能：持倉看不到「我加了幾筆、第一筆何時進的」
 *  - Sven 波段：沒有「持有天數 / 距停損 %」
 *
 * 全部 unix ms / 台幣，純函式方便單測。
 */
export interface FillLite {
  ts: number;
  symbol: string;
  action: 'Buy' | 'Sell';
  price: number;
  qty: number;
}

export interface StopInfo {
  pct: number;     // 距停損百分比（正 = 還有緩衝，負 = 已穿價）
  points: number;  // 距停損點數 / 元
  trigger: number; // 停損觸發價
}

export interface SmartOrderLite {
  symbol: string;
  order_type: string;
  action: string;
  trigger_price: number;
  is_active: boolean;
  is_triggered: boolean;
}

/**
 * 目前持倉方向「最早一筆同向進場」時間。
 * 多單由 Buy 建立、空單由 Sell 建立。找不到回 0。
 */
export function firstEntryTs(fills: FillLite[], direction: 'Buy' | 'Sell'): number {
  const sameDir = fills.filter((f) => f.action === direction && f.ts > 0);
  if (sameDir.length === 0) return 0;
  return Math.min(...sameDir.map((f) => f.ts));
}

/** 同向進場的累計筆數（分批加碼幾次）。 */
export function entryFillCount(fills: FillLite[], direction: 'Buy' | 'Sell'): number {
  return fills.filter((f) => f.action === direction && f.ts > 0).length;
}

/** 持有時間人話化。 */
export function formatHolding(ms: number): string {
  if (!(ms > 0)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 > 0 ? `${h}時${m % 60}分` : `${h}時`;
  const d = Math.floor(h / 24);
  return h % 24 > 0 ? `${d}天${h % 24}時` : `${d}天`;
}

/**
 * 在 smartOrders 找該 symbol 對應的停損觸發價。
 * 多單停損 = Sell STOP（取最高=最近）；空單停損 = Buy STOP（取最低=最近）。
 * 找不到回 0。
 */
export function nearestStopTrigger(
  smartOrders: SmartOrderLite[],
  symbol: string,
  direction: 'Buy' | 'Sell',
): number {
  const stopAction = direction === 'Buy' ? 'Sell' : 'Buy';
  const sym = symbol.toUpperCase();
  const triggers = smartOrders
    .filter(
      (o) =>
        (o.symbol || '').toUpperCase() === sym &&
        (o.order_type || '').toUpperCase().includes('STOP') &&
        o.action === stopAction &&
        o.is_active && !o.is_triggered &&
        o.trigger_price > 0,
    )
    .map((o) => o.trigger_price);
  if (triggers.length === 0) return 0;
  return direction === 'Buy' ? Math.max(...triggers) : Math.min(...triggers);
}

/**
 * 現價距停損距離。多單距離 = price - trigger；空單 = trigger - price。
 * pct 以 currentPrice 為分母。trigger<=0 或 price<=0 回 null。
 */
export function distanceToStop(
  currentPrice: number,
  direction: 'Buy' | 'Sell',
  trigger: number,
): StopInfo | null {
  if (!(currentPrice > 0) || !(trigger > 0)) return null;
  const points = direction === 'Buy' ? currentPrice - trigger : trigger - currentPrice;
  const pct = (points / currentPrice) * 100;
  return {
    points: Math.round(points * 100) / 100,
    pct: Math.round(pct * 100) / 100,
    trigger,
  };
}
