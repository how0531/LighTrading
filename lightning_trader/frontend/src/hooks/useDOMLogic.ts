import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useQuotes, useTradingCore } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { apiClient, normalizeApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { useApiErrorToast } from './useApiErrorToast';
import { splitOrders, randomDelay } from '../utils/splitOrder';
import { symbolMatches } from '../utils/instrument';
import { buildWorkingOrderMap } from '../utils/workingOrders';
import { playSound } from '../utils/sound';
import { resolveLots, type SizingMode } from '../utils/sizing';
import { useAccountEquity } from './useAccountEquity';
import type { QuoteData, BidAskData } from '../types';
import { getMultiplier } from '../types';

/** 下單回饋（ladder 格子閃爍用） */
export interface OrderFeedback {
  price: number;
  action: string;
  status: 'pending' | 'success' | 'error';
}

export function useDOMLogic() {
  // 低頻：連線 / 帳戶 / 委託 / actions
  const {
    targetSymbol, accountSummary, isStale,
    workingOrders, scheduleOrderRefresh, refreshOrders,
    smartOrders, refreshSmartOrders,
    accounts, activeAccount, selectAccount,
  } = useTradingCore();
  // 高頻：tick 資料
  const { quote, bidAsk } = useQuotes();
  const { toast } = useToast();
  const handleApiError = useApiErrorToast();

  const [orderType, setOrderType] = useState('ROD');
  const [priceType, setPriceType] = useState('LMT');
  const [orderCond, setOrderCond] = useState('Cash');
  const [orderLot, setOrderLot] = useState('Common');
  const [isSyncing, setIsSyncing] = useState(false);

  // 設定
  const { settings } = useSettings();
  const { hotkeys, splitOrder: splitCfg } = settings;

  // 下單回饋狀態
  const [orderFeedback, setOrderFeedback] = useState<OrderFeedback | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isOrderPendingRef = useRef(false);

  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  const qData: Partial<QuoteData> = quote ?? {};
  const bData: Partial<BidAskData> = bidAsk ?? {};

  // 報價衍生值：TradingContext.mergeQuote 已保證非零欄位跨 tick 黏滯
  // （Snapshot 靜態欄位不會被 0 洗掉），這裡直接純函式推導即可。
  const derived = useMemo(() => ({
    currentPrice: quote?.Price ?? 0,
    refPrice:     quote?.Reference ?? 0,
    limitUp:      quote?.LimitUp ?? 0,
    limitDown:    quote?.LimitDown ?? 0,
    highPrice:    quote?.High ?? 0,
    lowPrice:     quote?.Low ?? 0,
  }), [quote]);

  const { currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice } = derived;

  // ── 下單數量 ──
  // lots 模式的手動口數 state，加上「symbol / mode / 預設表變更」的校正。
  // 校正走 render 期 guarded setState（React 官方 derived-state 模式），
  // 取代原本三個 effect 內的同步 setState：
  //  - Sprint 20：切換商品（或編輯預設表）時套用 settings.qtyBySymbol 預設
  //  - Sprint 32 QA fix：amount/% 切回 lots 時套預設，無預設回 1
  const sizingMode: SizingMode = settings.sizing.mode;
  const presetMap = settings.qtyBySymbol;
  const [lotsState, setLotsState] = useState<{
    symbol: string; mode: SizingMode; presetMap: typeof presetMap; value: number;
  }>({ symbol: targetSymbol, mode: sizingMode, presetMap, value: 1 });
  if (lotsState.symbol !== targetSymbol || lotsState.mode !== sizingMode || lotsState.presetMap !== presetMap) {
    let value = lotsState.value;
    if (sizingMode === 'lots') {
      const preset = presetMap?.[(targetSymbol || '').toUpperCase()];
      if (lotsState.mode !== 'lots') value = preset && preset > 0 ? preset : 1;
      else if (preset && preset > 0) value = preset;
    }
    setLotsState({ symbol: targetSymbol, mode: sizingMode, presetMap, value });
  }

  const setOrderValue = useCallback((v: React.SetStateAction<number>) => {
    setLotsState((s) => ({ ...s, value: typeof v === 'function' ? v(s.value) : v }));
  }, []);

  // Sprint 28：智慧 sizing — 金額 / % 權益模式下，口數是「依當前價的純推導」，
  // 不再寫回 state（原本每個 tick setState 一次，是多餘的重繪來源）。
  const accountEquity = useAccountEquity();
  const orderValue = useMemo(() => {
    const sz = settings.sizing;
    if (sz.mode === 'lots') return lotsState.value;
    const price = currentPrice || refPrice;
    if (!price || !targetSymbol) return lotsState.value;
    const multiplier = getMultiplier(targetSymbol);
    const value = sz.mode === 'amount' ? sz.amount : sz.equityPct;
    const lots = resolveLots(sz.mode, value, { price, multiplier, equity: accountEquity });
    return lots > 0 ? lots : lotsState.value;
  }, [settings.sizing, lotsState.value, currentPrice, refPrice, targetSymbol, accountEquity]);

  const isSimulation = accountSummary?.is_simulation ?? true;

  // --- 掛單查找表（共用工廠，見 utils/workingOrders.ts） ---
  const workingBuyMap = useMemo(
    () => buildWorkingOrderMap(workingOrders, targetSymbol, 'Buy'),
    [workingOrders, targetSymbol],
  );
  const workingSellMap = useMemo(
    () => buildWorkingOrderMap(workingOrders, targetSymbol, 'Sell'),
    [workingOrders, targetSymbol],
  );

  // --- 報價閃爍邏輯 ---
  // 價格變動方向在 render 期比對（derived-state 模式）；effect 只負責 300ms 後清除
  const [flashState, setFlashState] = useState<{ price: number; dir: 'up' | 'down' | null }>(
    { price: currentPrice, dir: null },
  );
  if (flashState.price !== currentPrice) {
    setFlashState({ price: currentPrice, dir: currentPrice > flashState.price ? 'up' : 'down' });
  }
  const flashDir = flashState.dir;
  useEffect(() => {
    if (!flashDir) return;
    const timer = setTimeout(() => {
      setFlashState((s) => (s.dir ? { ...s, dir: null } : s));
    }, 300);
    return () => clearTimeout(timer);
  }, [flashState, flashDir]);

  // --- 手動同步按鈕 ---
  const handleManualSync = useCallback(async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      await refreshOrders();
      await refreshSmartOrders(targetSymbol);
      syncTimerRef.current = setTimeout(() => setIsSyncing(false), 500);
    } catch {
      setIsSyncing(false);
    }
  }, [isSyncing, refreshOrders, refreshSmartOrders, targetSymbol]);

  // --- 右上角顯示目前持倉 ---
  const currentPosition = useMemo(() => {
    if (!targetSymbol || !accountSummary?.positions) return null;
    return accountSummary.positions.find((p: { symbol: string }) =>
      symbolMatches(targetSymbol, p.symbol)
    ) || null;
  }, [accountSummary.positions, targetSymbol]);

  // --- 下單邏輯 ---
  const handlePlaceOrder = useCallback(async (price: number, action: 'Buy' | 'Sell') => {
    if (isOrderPendingRef.current || !targetSymbol) return;
    isOrderPendingRef.current = true;
    setOrderFeedback({ price, action, status: 'pending' });
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);

    const basePayload = {
      symbol: targetSymbol, price, action,
      order_type: orderType, price_type: priceType, order_cond: orderCond, order_lot: orderLot,
    };

    // 送單，處理後端 409 CONFIRM_REQUIRED（RiskManager WARNING 需 confirm:true 重送）。
    // 回傳 true=已下單, false=使用者拒絕確認。同一次操作只問一次，
    // 拆單後續批次沿用已確認結果。其餘錯誤 rethrow 給外層統一處理。
    let confirmGranted = false;
    const sendOrder = async (qty: number): Promise<boolean> => {
      const payload = confirmGranted
        ? { ...basePayload, qty, confirm: true }
        : { ...basePayload, qty };
      try {
        await apiClient.post('/place_order', payload);
        return true;
      } catch (e) {
        const err = normalizeApiError(e);
        if (err.status === 409 && err.code === 'CONFIRM_REQUIRED') {
          const message = [err.user_msg, ...(err.warnings ?? [])].filter(Boolean).join('\n');
          if (window.confirm(message)) {
            confirmGranted = true;
            // 重送「相同 payload + confirm:true」
            await apiClient.post('/place_order', { ...basePayload, qty, confirm: true });
            return true;
          }
          toast.info('已取消下單');
          return false;
        }
        throw e;
      }
    };

    try {
      let placedCount = 0;
      if (splitCfg.enabled && orderValue > splitCfg.threshold) {
        const lots = splitOrders(orderValue, splitCfg.minPerLot, splitCfg.maxPerLot);
        for (let i = 0; i < lots.length; i++) {
          const ok = await sendOrder(lots[i]);
          if (!ok) break; // 使用者拒絕確認 → 不再送出剩餘批次
          placedCount += 1;
          if (i < lots.length - 1) {
            await randomDelay(splitCfg.minDelay, splitCfg.maxDelay);
          }
        }
      } else {
        if (await sendOrder(orderValue)) placedCount = 1;
      }

      if (placedCount > 0) {
        setOrderFeedback({ price, action, status: 'success' });
        scheduleOrderRefresh();
        playSound('order_placed');
      } else {
        setOrderFeedback(null); // 使用者取消：清掉 pending 閃爍即可
      }
    } catch (e) {
      const err = normalizeApiError(e);
      setOrderFeedback({ price, action, status: 'error' });
      // WARNING 級風控已改為 409 CONFIRM_REQUIRED，在 sendOrder 內處理
      // （確認後帶 confirm=true 重送）；到這裡的都是真正的錯誤
      toast.error(err.user_msg || '下單失敗');
    }
    isOrderPendingRef.current = false;
    feedbackTimerRef.current = setTimeout(() => setOrderFeedback(null), 800);
  }, [targetSymbol, orderValue, orderType, priceType, orderCond, orderLot, splitCfg, scheduleOrderRefresh, toast]);

  const handleCancelOrder = useCallback(async (action: 'Buy' | 'Sell', price?: number) => {
    try {
      await apiClient.post('/cancel_all', { symbol: targetSymbol, action, price });
      scheduleOrderRefresh();
      playSound('cancel_order');
    } catch (e) {
      handleApiError(e, '刪單失敗');
    }
  }, [targetSymbol, scheduleOrderRefresh, handleApiError]);

  const handleAddStopOrder = useCallback(async (triggerPrice: number, action: 'Buy' | 'Sell') => {
    if (!targetSymbol) return;
    try {
      await apiClient.post('/smart_orders', {
        symbol: targetSymbol,
        order_type: 'STOP',
        action,
        qty: orderValue,
        trigger_price: triggerPrice,
        trigger_condition: action === 'Buy' ? '>=' : '<=',
        trailing_offset: 0,
        take_profit_price: 0,
        stop_loss_price: 0
      });
      toast.success(`觸價單已掛 @${triggerPrice}`);
      setTimeout(() => refreshSmartOrders(targetSymbol), 200);
    } catch (e) {
      handleApiError(e, '新增觸價單失敗');
    }
  }, [targetSymbol, orderValue, refreshSmartOrders, toast, handleApiError]);

  const handleDropOrder = useCallback(async (e: React.DragEvent, newPrice: number, tgtAction: 'Buy' | 'Sell') => {
    e.preventDefault();
    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (data.action !== tgtAction) return;

      const oldPrice = parseFloat(data.oldPriceStr);
      if (oldPrice === newPrice) return;

      const oldKey = Math.round(oldPrice * 100);
      const qty = (tgtAction === 'Buy' ? workingBuyMap : workingSellMap).get(oldKey) || 0;
      if (qty <= 0) return;

      await apiClient.post('/update_order', {
        symbol: targetSymbol,
        action: tgtAction,
        old_price: oldPrice,
        new_price: newPrice,
        qty: qty
      });

      playSound('order_replaced');
      scheduleOrderRefresh();
    } catch (e) {
      handleApiError(e, '改單失敗');
    }
  }, [targetSymbol, workingBuyMap, workingSellMap, scheduleOrderRefresh, handleApiError]);

  return {
    qData, bData, currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice, isSimulation,
    isStale, flashDir,
    orderValue, setOrderValue, orderType, setOrderType, priceType, setPriceType,
    orderCond, setOrderCond, orderLot, setOrderLot,
    isSyncing, handleManualSync,
    workingBuyMap, workingSellMap, currentPosition,
    handlePlaceOrder, handleCancelOrder, handleAddStopOrder, handleDropOrder,
    orderFeedback, smartOrders,
    targetSymbol, accountSummary, accounts, activeAccount, selectAccount,
    hotkeys,
    accountEquity,
  };
}
