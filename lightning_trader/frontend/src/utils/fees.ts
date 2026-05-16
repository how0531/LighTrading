/**
 * fees.ts — 台股 / 台期交易成本模型（純函式）
 *
 * 痛點來源：當沖戶 Daisy「手續費換算後實際入袋完全沒呈現」。
 * App 全程只顯示毛 PnL，當沖手續費佔比高會嚴重誤判賺賠。
 *
 * 模型（一次完整來回 = 進 + 出）：
 *   股票 (multiplier=1000)：
 *     手續費 = (進金額 + 出金額) × 費率% × 折數，每邊有低消
 *     證交稅 = 出金額 × 稅率%（賣方才課；當沖賣稅減半）
 *   期貨 (multiplier≠1000)：
 *     手續費 = 每口固定 × 口數 × 2（來回兩邊）
 *     期交稅 = (進金額 + 出金額) × 稅率%（雙邊各課）
 *
 * 數字皆為台幣，回傳四捨五入到整數。
 */
import { getMultiplier } from '../types';

export interface FeeConfig {
  stockFeeRatePct: number;   // 券商手續費率，預設 0.1425
  stockFeeDiscount: number;  // 折數 0~1（0.28 = 2.8 折）；1 = 無折扣
  stockTaxRatePct: number;   // 證交稅率，預設 0.3
  stockDayTrade: boolean;    // 當沖：賣方證交稅減半
  minStockFee: number;       // 每筆手續費低消（台幣），預設 20
  futFeePerLot: number;      // 期貨每口每邊手續費（台幣），預設 40
  futTaxRatePct: number;     // 期交稅率（百分比），預設 0.002（= 十萬分之二）
}

export const DEFAULT_FEE_CONFIG: FeeConfig = {
  stockFeeRatePct: 0.1425,
  stockFeeDiscount: 1,
  stockTaxRatePct: 0.3,
  stockDayTrade: false,
  minStockFee: 20,
  futFeePerLot: 40,
  futTaxRatePct: 0.002,
};

export function isStockMultiplier(multiplier: number): boolean {
  return multiplier === 1000;
}

/**
 * 一次完整來回（進場 entryPrice，出場 exitPrice，qty 張/口）的總交易成本。
 * 用於把毛 PnL 換成「平倉後實際入袋」。
 */
export function roundTripCost(
  symbol: string,
  qty: number,
  entryPrice: number,
  exitPrice: number,
  cfg: FeeConfig,
): number {
  if (!(qty > 0) || !(entryPrice > 0) || !(exitPrice > 0)) return 0;
  const m = getMultiplier(symbol);
  const notionalIn = entryPrice * qty * m;
  const notionalOut = exitPrice * qty * m;

  if (isStockMultiplier(m)) {
    const feeRate = (cfg.stockFeeRatePct / 100) * cfg.stockFeeDiscount;
    const feeIn = Math.max(notionalIn * feeRate, cfg.minStockFee);
    const feeOut = Math.max(notionalOut * feeRate, cfg.minStockFee);
    const taxRate = (cfg.stockDayTrade ? cfg.stockTaxRatePct / 2 : cfg.stockTaxRatePct) / 100;
    const tax = notionalOut * taxRate; // 賣方才課
    return Math.round(feeIn + feeOut + tax);
  }

  const fee = cfg.futFeePerLot * qty * 2; // 來回兩邊
  const tax = (notionalIn + notionalOut) * (cfg.futTaxRatePct / 100);
  return Math.round(fee + tax);
}

/**
 * 毛 PnL → 淨 PnL（扣掉一次來回成本）。
 * 對未平倉部位，exitPrice 帶入「現價」= 立刻平倉可入袋的估計值。
 */
export function netPnL(
  grossPnL: number,
  symbol: string,
  qty: number,
  entryPrice: number,
  exitPrice: number,
  cfg: FeeConfig,
): number {
  const cost = roundTripCost(symbol, qty, entryPrice, exitPrice, cfg);
  return Math.round(grossPnL - cost);
}
