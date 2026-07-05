/**
 * useMiniDomOrder — ⚡全開宮格（MultiDOMGrid / MiniDOM）的下單流程（Sprint D）
 *
 * 與主 DOM（useDOMLogic）同語意，但參數化 symbol（useDOMLogic 綁 targetSymbol）：
 *   - 前端二次確認：settings.confirmations.placeOrder 且非戰鬥模式才問；
 *     文案含商品代碼（宮格同時盯多檔，必須看得出這一筆是哪一檔）
 *   - 戰鬥模式：跳過確認一鍵直送
 *   - 後端風控 409 CONFIRM_REQUIRED：共用 utils/orderExec.placeOrderWithRiskConfirm
 *     （danger 確認框 → 同 payload + confirm:true 重送）
 *   - in-flight 去重「按商品隔離」：2330 送出中不擋 2454，同商品連點才擋
 *   - 成功：下單音效 + toast + scheduleOrderRefresh
 *
 * 一律送 LMT 限價（點買側=該價掛買、點賣側=該價掛賣）；
 * order_type/cond/lot 用主 DOM 的預設（ROD / Cash / Common）。
 */
import { useCallback, useRef } from 'react';
import { useTradingCore } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { normalizeApiError } from '../api/client';
import { placeOrderWithRiskConfirm } from '../utils/orderExec';
import { formatPrice } from '../utils/instrument';
import { playSound } from '../utils/sound';

export function useMiniDomOrder() {
  const { scheduleOrderRefresh } = useTradingCore();
  const { settings } = useSettings();
  const { toast } = useToast();
  const { confirm } = useConfirm();

  // in-flight 去重：以 symbol 為 key，各商品互不阻擋
  const pendingSymbolsRef = useRef<Set<string>>(new Set());
  // 被 block 時的輕量回饋（1 秒內不重複跳，比照 useDOMLogic）
  const blockedToastAtRef = useRef(0);

  const placeFromGrid = useCallback(async (
    symbol: string,
    price: number,
    action: 'Buy' | 'Sell',
    qty: number,
  ): Promise<void> => {
    const sym = (symbol || '').trim().toUpperCase();
    if (!sym || !(price > 0) || !(qty > 0)) return;

    if (pendingSymbolsRef.current.has(sym)) {
      const now = Date.now();
      if (now - blockedToastAtRef.current >= 1000) {
        blockedToastAtRef.current = now;
        toast.info(`${sym} 上一筆處理中…`);
      }
      return;
    }
    pendingSymbolsRef.current.add(sym);
    try {
      // 前端二次確認（戰鬥模式跳過）；通過即帶 confirm:true，避免與後端 409 重複詢問
      let preConfirmed = false;
      if (settings.confirmations.placeOrder && !settings.isCombatMode) {
        const dir = action === 'Buy' ? '買進' : '賣出';
        const ok = await confirm({
          title: '下單確認（宮格）',
          message: `確認${dir} ${sym} ${qty} 單位 @ ${formatPrice(price, sym)}？`,
          confirmLabel: `確認${dir}`,
        });
        if (!ok) return;
        preConfirmed = true;
      }

      const payload = {
        symbol: sym, price, action, qty,
        order_type: 'ROD', price_type: 'LMT', order_cond: 'Cash', order_lot: 'Common',
      };
      try {
        const outcome = await placeOrderWithRiskConfirm(payload, confirm, preConfirmed);
        if (outcome.placed) {
          playSound('order_placed');
          const dirZh = action === 'Buy' ? '買' : '賣';
          toast.success(`⚡ ${sym} ${dirZh} ${qty} @ ${formatPrice(price, sym)} ✓`);
          scheduleOrderRefresh();
        } else {
          toast.info('已取消下單');
        }
      } catch (e) {
        const err = normalizeApiError(e);
        toast.error(err.user_msg || `${sym} 下單失敗`);
      }
    } finally {
      pendingSymbolsRef.current.delete(sym);
    }
  }, [settings.confirmations.placeOrder, settings.isCombatMode, confirm, toast, scheduleOrderRefresh]);

  return { placeFromGrid };
}
