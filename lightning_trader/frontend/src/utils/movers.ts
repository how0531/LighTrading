/**
 * movers.ts — 盤勢排行 / 市場寬度的純函式（Sprint 36）
 *
 * 從自選清單的即時報價（MiniQuote）算出:
 *   - 漲幅榜 / 跌幅榜（依漲跌% 排序的前 N 名）— rankMovers
 *   - 市場寬度:上漲 / 下跌 / 平盤 家數與比例 — computeBreadth
 *
 * 與 quoteBoard.ts 共用 computeChange,確保漲跌計算口徑一致。
 * 抽成純函式方便獨立 vitest 測試,讓 MoversPanel 只負責渲染。
 */
import { computeChange } from './quoteBoard';

export interface MoverInput {
  symbol: string;
  price?: number;
  reference?: number;
}

export interface MoverRow {
  symbol: string;
  price: number;
  change: number;
  pct: number;
}

/**
 * 把報價列轉成「有有效漲跌資料」的 MoverRow,並依漲跌% 排序。
 *  - dir='gainers' → 由大到小（漲幅榜）
 *  - dir='losers'  → 由小到大（跌幅榜,最跌的在最前）
 * 無有效漲跌（價/參考價 <= 0）的列直接濾掉,不佔榜單名額。
 * 回傳前 limit 名;limit <= 0 視為不限制。
 */
export function rankMovers(rows: MoverInput[], dir: 'gainers' | 'losers', limit = 5): MoverRow[] {
  const enriched: MoverRow[] = [];
  for (const r of rows) {
    const ch = computeChange(r.price ?? 0, r.reference ?? 0);
    if (!ch) continue;
    enriched.push({ symbol: r.symbol, price: r.price ?? 0, change: ch.change, pct: ch.pct });
  }
  enriched.sort((a, b) => (dir === 'gainers' ? b.pct - a.pct : a.pct - b.pct));
  return limit > 0 ? enriched.slice(0, limit) : enriched;
}

export interface Breadth {
  up: number;        // 上漲家數
  down: number;      // 下跌家數
  flat: number;      // 平盤家數（有有效報價但漲跌為 0）
  noData: number;    // 無有效報價家數
  total: number;     // 自選清單總數
  /** 上漲佔（上漲+下跌）的百分比;無漲跌家數時 50 */
  upPct: number;
}

/**
 * 統計市場寬度（漲跌家數）。
 * 平盤 = 有報價但 change === 0;noData = 無有效報價。
 */
export function computeBreadth(rows: MoverInput[]): Breadth {
  let up = 0;
  let down = 0;
  let flat = 0;
  let noData = 0;
  for (const r of rows) {
    const ch = computeChange(r.price ?? 0, r.reference ?? 0);
    if (!ch) {
      noData++;
    } else if (ch.change > 0) {
      up++;
    } else if (ch.change < 0) {
      down++;
    } else {
      flat++;
    }
  }
  const decisive = up + down;
  return {
    up,
    down,
    flat,
    noData,
    total: rows.length,
    upPct: decisive > 0 ? (up / decisive) * 100 : 50,
  };
}
