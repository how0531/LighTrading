/**
 * orderExec.ts — 下單執行核心（Sprint D）
 *
 * 從 useDOMLogic.sendOrder 抽出「POST /place_order + 後端風控 409 CONFIRM_REQUIRED
 * 確認重送」這一段可共用的流程，讓主 DOM（useDOMLogic，含拆單逐批沿用已確認結果）
 * 與 MultiDOMGrid 的 MiniDOM（useMiniDomOrder）走同一套風控語意：
 *
 *   1. preConfirmed=true（前端二次確認已通過）→ 首發即帶 confirm:true，
 *      避免與後端 RiskManager WARNING 的 409 重複，一次下單最多問一次
 *   2. 409 CONFIRM_REQUIRED → danger 確認框（user_msg + warnings 全文）→
 *      同 payload + confirm:true 重送；拒絕 → placed=false（呼叫端負責提示）
 *   3. 其餘錯誤原樣 rethrow，呼叫端統一 normalizeApiError + toast
 *
 * 刻意不碰 useDOMLogic 的其他職責（追價模式 / 拆單排程 / sizing / 回饋閃爍），
 * 那些綁 targetSymbol 與面板 state，抽出來只會把參數表變成另一個 hook。
 */
import { apiClient, normalizeApiError } from '../api/client';
import type { ConfirmOptions } from '../contexts/ConfirmContext';

export interface RiskConfirmOutcome {
  /** true = 已成功送出（可能經過 409 確認重送） */
  placed: boolean;
  /** true = 這一筆取得了風控授權（前端預確認或 409 確認框接受）。
   *  拆單呼叫端把它記下來，後續批次以 preConfirmed 傳回，不再重複詢問 */
  confirmGranted: boolean;
}

/**
 * 送出一筆委託並處理後端風控 409 CONFIRM_REQUIRED。
 * @param payload  /place_order 的完整 payload（symbol/price/action/qty/order_type…）
 * @param confirm  useConfirm 的 confirm（promise-based 對話框）
 * @param preConfirmed  已取得授權 → 首發直接帶 confirm:true
 */
export async function placeOrderWithRiskConfirm(
  payload: Record<string, unknown>,
  confirm: (opts: ConfirmOptions) => Promise<boolean>,
  preConfirmed = false,
): Promise<RiskConfirmOutcome> {
  const body = preConfirmed ? { ...payload, confirm: true } : payload;
  try {
    await apiClient.post('/place_order', body);
    return { placed: true, confirmGranted: preConfirmed };
  } catch (e) {
    const err = normalizeApiError(e);
    if (err.status === 409 && err.code === 'CONFIRM_REQUIRED') {
      const message = [err.user_msg, ...(err.warnings ?? [])].filter(Boolean).join('\n');
      // 風控警告：danger 樣式對話框（promise-based，不阻塞報價更新）
      const ok = await confirm({
        title: '風控警告',
        message,
        confirmLabel: '確認送單',
        danger: true,
      });
      if (ok) {
        // 重送「相同 payload + confirm:true」
        await apiClient.post('/place_order', { ...payload, confirm: true });
        return { placed: true, confirmGranted: true };
      }
      return { placed: false, confirmGranted: false };
    }
    throw e;
  }
}
