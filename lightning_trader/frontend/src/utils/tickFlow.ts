/**
 * tickFlow.ts — 逐筆成交（Time & Sales）的訂單流分析純函式（Sprint 35）
 *
 * 抽出「內外盤判定 / 大單偵測 / 買賣力道彙總」,方便獨立 vitest 測試,
 * 讓 TimeSalesPanel 只負責渲染。
 *
 * 內外盤（aggressor side）判定依 Shioaji TickType:
 *   1 = 外盤成交（主動買,通常台灣以紅色表示「買方吃掉賣單」）→ 'buy'
 *   2 = 內盤成交（主動賣,綠色）→ 'sell'
 *   0 = 無法判定 → 退回用「現價 vs 前一筆價」推估,平盤則 'neutral'
 */

export type Aggressor = 'buy' | 'sell' | 'neutral';

/**
 * 判定該筆成交的主動方。
 * tickType 明確（1/2）時直接採用;為 0/未知時用價格變化推估。
 */
export function classifyAggressor(
  tickType: number | undefined,
  price: number,
  prevPrice: number | undefined,
): Aggressor {
  if (tickType === 1) return 'buy';
  if (tickType === 2) return 'sell';
  // 無法判定 → 價格推估
  if (prevPrice === undefined || !(price > 0) || !(prevPrice > 0)) return 'neutral';
  if (price > prevPrice) return 'buy';
  if (price < prevPrice) return 'sell';
  return 'neutral';
}

/**
 * 是否為大單:成交量 >= 門檻（張/口）。門檻 <= 0 視為關閉（永遠 false）。
 */
export function isBigTrade(volume: number, threshold: number): boolean {
  if (threshold <= 0) return false;
  return volume >= threshold;
}

export interface FlowTick {
  price: number;
  volume: number;
  tickType?: number;
}

export interface FlowSummary {
  buyVol: number;     // 外盤累計量
  sellVol: number;    // 內盤累計量
  neutralVol: number; // 無法判定累計量
  delta: number;      // buyVol - sellVol（正 = 買方主導）
  total: number;      // 總量
  buyPct: number;     // 外盤佔（buy+sell）的百分比;無買賣量時 50
}

/**
 * 彙總一串逐筆成交的買賣力道。
 * ticks 預期由新到舊或舊到新皆可（順序不影響加總);
 * 推估內外盤時以「陣列中前一個元素」為前一筆價,故傳入順序需與顯示一致
 * （本面板由新到舊,第 0 筆為最新）。
 */
export function summarizeFlow(ticks: FlowTick[]): FlowSummary {
  let buyVol = 0;
  let sellVol = 0;
  let neutralVol = 0;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    const prev = ticks[i + 1]; // 由新到舊 → 下一個 index 是更舊的一筆
    const side = classifyAggressor(t.tickType, t.price, prev?.price);
    const v = t.volume > 0 ? t.volume : 0;
    if (side === 'buy') buyVol += v;
    else if (side === 'sell') sellVol += v;
    else neutralVol += v;
  }
  const decisive = buyVol + sellVol;
  return {
    buyVol,
    sellVol,
    neutralVol,
    delta: buyVol - sellVol,
    total: buyVol + sellVol + neutralVol,
    buyPct: decisive > 0 ? (buyVol / decisive) * 100 : 50,
  };
}
