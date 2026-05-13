/**
 * pnl.ts — 純函式：給定最新成交價與持倉清單，算出每筆即時 PnL 與總計。
 *
 * 這份從 TradingContext.tsx 的 100ms throttle 區塊抽出，目的是：
 *  1. 同邏輯可單獨測試
 *  2. context 中介只負責 wiring，不再內嵌計算
 */
import type { RealtimePosition } from '../contexts/TradingContext';
import { getMultiplier } from '../types';

interface AccountPositionLite {
  symbol: string;
  qty: number;
  direction: 'Buy' | 'Sell';
  price: number;
  pnl: number;
  account?: string;
  raw_qty?: number;
}

export interface LocalPnLResult {
  positions: RealtimePosition[];
  totalPnl: number;
}

/**
 * 計算當前 targetSymbol 對應持倉的即時 PnL。
 * 非 targetSymbol 的持倉一律退回 broker 給的 pos.pnl，避免「拿一個價格算所有商品」的錯誤。
 */
export function computeLocalPnL(
  positions: AccountPositionLite[] | undefined | null,
  latestPrice: number,
  targetSymbol: string,
): LocalPnLResult {
  if (!positions || positions.length === 0 || !(latestPrice > 0)) {
    return { positions: [], totalPnl: 0 };
  }

  const tgt = (targetSymbol || '').toUpperCase();
  const tgtCode = tgt.replace(/\D/g, '');

  let totalPnl = 0;
  const out: RealtimePosition[] = positions.map((pos) => {
    const posSym = (pos.symbol || '').toUpperCase();
    const matches = posSym === tgt || (!!tgtCode && posSym.includes(tgtCode));
    if (matches && pos.price > 0) {
      const multiplier = getMultiplier(pos.symbol);
      const direction = pos.direction === 'Buy' ? 1 : -1;
      const pnlPerUnit = (latestPrice - pos.price) * direction;
      const realtimePnl = Math.round(pnlPerUnit * pos.qty * multiplier);
      totalPnl += realtimePnl;
      return { ...pos, realtimePnl, pnlPerUnit, currentPrice: latestPrice };
    }
    const fallback = pos.pnl || 0;
    totalPnl += fallback;
    return { ...pos, realtimePnl: fallback, pnlPerUnit: 0, currentPrice: 0 };
  });

  return { positions: out, totalPnl };
}
