/**
 * instrument.ts — 商品代號相關的單一真實來源
 *
 * 取代散落於 utils/tickSize.ts、components/DOM/DOMTable.tsx、components/DOM/DOMHeader.tsx
 * 的重複實作。所有對「合約屬性」的查詢都從這裡來。
 */

const FUTURES_TICK = 1;
const MICRO_INDEX_TICK = 0.25;

/**
 * 取得指定價格 / 商品的 tick 級距。
 */
export function getTickSize(price: number, symbol: string): number {
  const sym = (symbol || '').toUpperCase();
  if (sym.startsWith('TXF') || sym.startsWith('MXF') || sym.startsWith('TX') || sym.startsWith('MX')) return FUTURES_TICK;
  if (sym.startsWith('UD')  || sym.startsWith('MYM')) return FUTURES_TICK;
  if (sym.startsWith('NQ')  || sym.startsWith('MNQ')) return MICRO_INDEX_TICK;
  if (sym.startsWith('ES')  || sym.startsWith('MES')) return MICRO_INDEX_TICK;

  // 台股：依照 TWSE 級距
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.10;
  if (price < 500) return 0.50;
  if (price < 1000) return 1.00;
  if (price >= 10000) return 1.00;
  return 5.00;
}

/**
 * 把價格依商品類型格式化為字串。
 */
export function formatPrice(price: number, symbol: string): string {
  const sym = (symbol || '').toUpperCase();
  if (sym.startsWith('TXF') || sym.startsWith('MXF') || sym.startsWith('TX') || sym.startsWith('MX') || sym.startsWith('UD') || sym.startsWith('MYM')) {
    return price.toFixed(0);
  }
  if (sym.startsWith('NQ') || sym.startsWith('MNQ') || sym.startsWith('ES') || sym.startsWith('MES')) {
    return price.toFixed(2);
  }
  if (price >= 1000) return price.toFixed(0);
  if (price >= 100)  return price.toFixed(1);
  return price.toFixed(2);
}

/**
 * 是否為台股股票（4 碼數字）。
 */
export function isStockSymbol(symbol: string): boolean {
  const sym = (symbol || '').trim();
  return sym.length === 4 && /^\d{4}$/.test(sym);
}

/**
 * 商品代號比對：
 *   - 完全相同 → 命中
 *   - target 全為純數字（台股代號）→ 允許 substring（例如 '2330' 命中 'TSE2330'）
 *   - 否則（期貨/選擇權）必須精確匹配，避免 'TXFR1' 用 digit '1' 誤匹配 'MXFR1'
 */
export function symbolMatches(target: string, candidate: string): boolean {
  if (!target || !candidate) return false;
  const t = target.toUpperCase();
  const c = candidate.toUpperCase();
  if (t === c) return true;
  if (/^\d{4,}$/.test(t)) return c.includes(t);
  return false;
}
