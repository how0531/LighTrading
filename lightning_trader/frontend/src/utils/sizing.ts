/**
 * sizing.ts — 把使用者偏好的「下單尺寸表達」轉成 broker 認得的張數 / 口數
 *
 * 三種模式：
 *   - lots         直接以張/口
 *   - amount       固定金額（台幣），按當前價自動換算
 *   - equity_pct   用戶總權益的百分比，按當前價自動換算
 *
 * 公式：lots = floor(targetCash / (price × multiplier))
 *       targetCash = amount (mode=amount) 或 equity × pct/100 (mode=equity_pct)
 *
 * 算出 < 1 時回 0；UI 端依此選擇顯示 "—" 或保持上次值。
 */
export type SizingMode = 'lots' | 'amount' | 'equity_pct';

export interface SizingContext {
  price: number;
  multiplier: number;
  equity: number;
}

function safeFloor(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export function amountToLots(amount: number, ctx: SizingContext): number {
  if (!amount || amount <= 0) return 0;
  if (!ctx.price || ctx.price <= 0) return 0;
  if (!ctx.multiplier || ctx.multiplier <= 0) return 0;
  return safeFloor(amount / (ctx.price * ctx.multiplier));
}

export function equityPctToLots(pct: number, ctx: SizingContext): number {
  if (!pct || pct <= 0 || pct > 100) return 0;
  if (!ctx.equity || ctx.equity <= 0) return 0;
  return amountToLots(ctx.equity * (pct / 100), ctx);
}

export function lotsToAmount(lots: number, ctx: SizingContext): number {
  if (lots <= 0 || ctx.price <= 0 || ctx.multiplier <= 0) return 0;
  return lots * ctx.price * ctx.multiplier;
}

/**
 * 統一 dispatcher。lots 模式 value 即 lots；其他模式 value 是金額或 %。
 * lots 模式保證至少 1（避免使用者下 0 張）；其他模式不夠錢就回 0。
 */
export function resolveLots(
  mode: SizingMode,
  value: number,
  ctx: SizingContext,
): number {
  if (mode === 'lots') return Math.max(1, safeFloor(value));
  if (mode === 'amount') return amountToLots(value, ctx);
  if (mode === 'equity_pct') return equityPctToLots(value, ctx);
  return 0;
}
