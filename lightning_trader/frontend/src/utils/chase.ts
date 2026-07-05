/**
 * chase.ts — CHASE 追價智慧單的前後端契約（Sprint C）
 *
 * 後端契約（欄位名不可改）：
 *   POST /smart_orders
 *   {
 *     "order_type": "CHASE",
 *     "symbol": "...", "action": "Buy"|"Sell", "quantity": 2,
 *     "max_chase_ticks": 10,
 *     "reprice_ticks": 1,
 *     "reprice_interval_ms": 1500,
 *     "final_action": "GIVE_UP"|"MARKET"
 *   }
 *
 * 取消走既有智慧單取消端點（DELETE /smart_orders/{id}）。
 * reprice_ticks 與 reprice_interval_ms 前端一律用預設值（Sprint C 範圍）。
 */

export type ChaseFinalAction = 'GIVE_UP' | 'MARKET';

/** reprice_* 兩個欄位 Sprint C 不開放 UI 設定，統一用預設 */
export const CHASE_DEFAULTS = {
  repriceTicks: 1,
  repriceIntervalMs: 1500,
} as const;

export interface ChasePayloadParams {
  symbol: string;
  action: 'Buy' | 'Sell';
  quantity: number;
  maxChaseTicks: number;
  finalAction: ChaseFinalAction;
}

/** 組出符合後端契約的 CHASE 建立 payload（單一真實來源，DOM / 智慧單面板 / 鋪單共用） */
export function buildChasePayload(p: ChasePayloadParams) {
  return {
    order_type: 'CHASE' as const,
    symbol: p.symbol,
    action: p.action,
    quantity: p.quantity,
    max_chase_ticks: p.maxChaseTicks,
    reprice_ticks: CHASE_DEFAULTS.repriceTicks,
    reprice_interval_ms: CHASE_DEFAULTS.repriceIntervalMs,
    final_action: p.finalAction,
  };
}
