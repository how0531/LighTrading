/**
 * layOrders.ts — 鋪單（多價位掛單）價格計算（Sprint C）
 *
 * 買單由起始價往下鋪、賣單往上鋪；每一步以「當前價位的 tick 級距」推進
 * （與 DOMPanel ladder 展開的口徑一致），跨級距邊界時自然換檔。
 */
import { getTickSize } from './instrument';

/** 精確四捨五入避免浮點漂移（與 DOMPanel round2 同口徑） */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 價格貼齊該商品的 tick 級距 */
export function roundToTick(price: number, symbol: string): number {
  const tick = getTickSize(price, symbol);
  return round2(Math.round(price / tick) * tick);
}

export interface LayPlanParams {
  side: 'Buy' | 'Sell';
  /** 檔數 N（UI 限 2–10；純函式不強制上限，只保證 >=1 才有輸出） */
  levels: number;
  /** 起始價（會先貼齊 tick） */
  startPrice: number;
  /** 每檔間距（tick 數，>=1） */
  gapTicks: number;
  symbol: string;
}

/**
 * 依方向展開 N 檔價位：
 *   Buy  → [start, start-gap, start-2*gap, ...]（往下）
 *   Sell → [start, start+gap, start+2*gap, ...]（往上）
 * 價格 <= 0 時提前停止（防禦：往下鋪到穿零）。
 */
export function computeLayPrices({ side, levels, startPrice, gapTicks, symbol }: LayPlanParams): number[] {
  const n = Math.floor(levels);
  const gap = Math.max(1, Math.floor(gapTicks));
  if (n < 1 || !(startPrice > 0)) return [];

  const prices: number[] = [];
  let p = roundToTick(startPrice, symbol);
  for (let i = 0; i < n; i++) {
    if (!(p > 0)) break;
    prices.push(p);
    for (let g = 0; g < gap; g++) {
      const tick = getTickSize(p, symbol);
      p = round2(side === 'Buy' ? p - tick : p + tick);
      if (!(p > 0)) break;
    }
  }
  return prices;
}
