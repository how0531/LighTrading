/**
 * riskToastDedupe — 風控熔斷「停止交易」toast 的跨通道去重（P3）
 *
 * 同一次熔斷事件會同時經兩條路徑被偵測到：
 *   1. TradingContext 的 WS RiskStatusUpdate（即時，block 級）
 *   2. useRiskStatus 的 30s 輪詢 trading_enabled true→false 轉場
 * 兩者訊息字串不同，各自 toast → 使用者短時間內看到兩則「已停止交易」。
 *
 * 這個 module-level 時間戳讓兩條路徑共用一個「最近是否已提示過熔斷」窗口：
 * 先發的記時間，後到的在窗口內就不再重複 toast（音效同理）。
 */
let lastHaltToastAt = 0;

const DEDUPE_WINDOW_MS = 10_000;

/** 最近 window 內是否已對「停止交易」提示過（用於後到通道判斷是否略過）。 */
export function riskHaltToastedRecently(now: number = Date.now(), windowMs: number = DEDUPE_WINDOW_MS): boolean {
  return now - lastHaltToastAt < windowMs;
}

/** 記錄本通道剛剛提示過熔斷（另一通道在窗口內就會被 riskHaltToastedRecently 擋下）。 */
export function markRiskHaltToasted(now: number = Date.now()): void {
  lastHaltToastAt = now;
}
