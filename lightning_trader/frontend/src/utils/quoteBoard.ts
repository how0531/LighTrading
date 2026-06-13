/**
 * quoteBoard.ts — 報價看板的純函式（Sprint 34）
 *
 * 抽出排序 / 漲跌計算 / stale 判定,方便獨立 vitest 測試,
 * 讓 QuoteBoardPanel 元件只負責渲染與互動。
 */

export type QuoteSortKey = 'symbol' | 'price' | 'changePct' | 'volume';
export type SortDir = 'asc' | 'desc';

export interface QuoteChange {
  change: number;   // 漲跌價 = 成交 - 參考價
  pct: number;      // 漲跌幅 %
}

/**
 * 計算漲跌。參考價或成交價無效（<= 0）時回 null,UI 顯示「—」。
 */
export function computeChange(price: number, reference: number): QuoteChange | null {
  if (!(price > 0) || !(reference > 0)) return null;
  const change = price - reference;
  return { change, pct: (change / reference) * 100 };
}

/**
 * stale 判定:距上次更新超過 thresholdMs（預設 10 秒）視為過時。
 * 沒有 updatedAt（從未收到報價）也算 stale。
 */
export function isStaleQuote(updatedAt: number | undefined, now: number, thresholdMs = 10_000): boolean {
  if (!updatedAt) return true;
  return now - updatedAt > thresholdMs;
}

export interface SortableQuote {
  symbol: string;
  price?: number;
  reference?: number;
  volume?: number;
}

/**
 * 依指定欄位排序。
 *  - symbol 用 localeCompare（字串）
 *  - price / volume 用數值,缺值當 0
 *  - changePct 透過 computeChange 算;沒有漲跌資料的列用 -Infinity,
 *    確保它們在升冪時墊底、不會混進有效資料中間造成跳動
 * 回傳新陣列,不就地修改輸入。
 */
export function sortQuotes<T extends SortableQuote>(rows: T[], key: QuoteSortKey, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const valueOf = (r: T): number | string => {
    switch (key) {
      case 'symbol':
        return r.symbol;
      case 'price':
        return r.price ?? 0;
      case 'volume':
        return r.volume ?? 0;
      case 'changePct': {
        const c = computeChange(r.price ?? 0, r.reference ?? 0);
        return c ? c.pct : -Infinity;
      }
    }
  };
  return [...rows].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (typeof va === 'string' && typeof vb === 'string') {
      return sign * va.localeCompare(vb);
    }
    return sign * ((va as number) - (vb as number));
  });
}
