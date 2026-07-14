import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useQuotes, useTradingCore } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { apiClient, normalizeApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { useApiErrorToast } from './useApiErrorToast';
import { splitOrders, randomDelay } from '../utils/splitOrder';
import { placeOrderWithRiskConfirm } from '../utils/orderExec';
import { buildChasePayload } from '../utils/chase';
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

/** 拆單進度（大單拆多筆連送時暴露給 UI 顯示 + 中止） */
export interface SplitProgress {
  sent: number;
  total: number;
  aborted: boolean;
}

/** 拖曳改價進行中（UX 批次 4 Item 6）：舊價位掛單標籤顯示「改價中」樣式 */
export interface ReplacingOrder {
  price: number;
  action: 'Buy' | 'Sell';
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
  const { confirm } = useConfirm();
  const handleApiError = useApiErrorToast();

  const [orderType, setOrderType] = useState('ROD');
  const [priceType, setPriceType] = useState('LMT');
  // Sprint C：DOM 追價模式 — 開啟時 ladder 點價 / 追買追賣熱鍵改送 CHASE 智慧單。
  // 一次性 UI 狀態（不持久化）：追價是高風險的「動態掛單」，不該跨 session 殘留。
  const [chaseMode, setChaseMode] = useState(false);
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
  // in-flight 去重被 block 時的輕量回饋（toast 節流：1 秒內不重複跳）
  const blockedToastAtRef = useRef(0);

  // 拆單進度 + 中止（Sprint UX3）
  const [splitProgress, setSplitProgress] = useState<SplitProgress | null>(null);
  const splitAbortRef = useRef(false);
  // 中止後讓「已中止 x/y」狀態短暫顯示再清（見 finally；否則 finally 立即清、UI 永不渲染）
  const splitClearTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortSplit = useCallback(() => { splitAbortRef.current = true; }, []);

  // 拖曳改價中的掛單（Item 6）：送出期間舊價位標籤轉虛線半透明
  const [replacingOrder, setReplacingOrder] = useState<ReplacingOrder | null>(null);

  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      if (splitClearTimerRef.current) clearTimeout(splitClearTimerRef.current);
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
  // overridePriceType：市價熱鍵（Item 8）等呼叫端可強制 MKT，不動使用者的 priceType 選單
  const handlePlaceOrder = useCallback(async (price: number, action: 'Buy' | 'Sell', overridePriceType?: string) => {
    if (!targetSymbol) return;
    const effPriceType = overridePriceType ?? priceType;
    if (isOrderPendingRef.current) {
      // in-flight 去重：上一筆還在送 → 輕量回饋（1 秒內不重複跳）
      const now = Date.now();
      if (now - blockedToastAtRef.current >= 1000) {
        blockedToastAtRef.current = now;
        toast.info('上一筆處理中…');
      }
      return;
    }
    isOrderPendingRef.current = true;
    try {
      // ── Sprint C：追價模式 ─────────────────────────────
      // 開啟時 ladder 點價與追買/追賣熱鍵改送 CHASE 智慧單（後端動態追價）；
      // 市價熱鍵（overridePriceType=MKT/MKP）與刪單不受影響。
      // 沿用 in-flight 去重（上方）與確認流（確認文案標明「追價單」）。
      if (chaseMode && effPriceType !== 'MKT' && effPriceType !== 'MKP') {
        if (settings.confirmations.placeOrder && !settings.isCombatMode) {
          const dir = action === 'Buy' ? '買進' : '賣出';
          const finalZh = settings.chase.finalAction === 'MARKET' ? '轉市價' : '放棄';
          const ok = await confirm({
            title: '追價單確認',
            message: `確認送出追價單：${dir} ${targetSymbol} ${orderValue} 單位？\n（最多追 ${settings.chase.maxChaseTicks} tick，追不到則${finalZh}）`,
            confirmLabel: `確認${dir}（追價）`,
          });
          if (!ok) return;
        }
        setOrderFeedback({ price, action, status: 'pending' });
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        try {
          await apiClient.post('/smart_orders', buildChasePayload({
            symbol: targetSymbol,
            action,
            quantity: orderValue,
            maxChaseTicks: settings.chase.maxChaseTicks,
            finalAction: settings.chase.finalAction,
          }));
          setOrderFeedback({ price, action, status: 'success' });
          playSound('order_placed');
          toast.success(`追價${action === 'Buy' ? '買' : '賣'} ${orderValue} 已送出 ⚡`);
          scheduleOrderRefresh();
          setTimeout(() => refreshSmartOrders(targetSymbol), 200);
        } catch (e) {
          const err = normalizeApiError(e);
          setOrderFeedback({ price, action, status: 'error' });
          toast.error(err.user_msg || '追價單送出失敗');
        }
        feedbackTimerRef.current = setTimeout(() => setOrderFeedback(null), 800);
        return;
      }

      // C3：前端二次確認 —— 戰鬥模式（已解鎖=明確意圖）一鍵直送、跳過此框；否則若開啟
      // 下單確認則先問。但「一般下單確認框」只確認「要下這筆單」的意圖，**不**等於授權
      // 跳過後端風控 WARNING（價格偏離／市價／反向）。故確認通過後首發仍不帶 confirm，
      // 讓後端 RiskManager 有 WARNING 時回 409 CONFIRM_REQUIRED，再由
      // placeOrderWithRiskConfirm 以「含全文」的 danger 框授權後帶 confirm:true 重送
      // （比照 useLayOrders 的 P1-1）。之前預帶 confirm:true 會讓後端 skip_warnings 靜默丟掉警告。
      if (settings.confirmations.placeOrder && !settings.isCombatMode) {
        const dir = action === 'Buy' ? '買進' : '賣出';
        const at = (effPriceType === 'MKT' || effPriceType === 'MKP') ? '市價' : price;
        const ok = await confirm({
          title: '下單確認',
          message: `確認${dir} ${targetSymbol} ${orderValue} 單位 @ ${at}？`,
          confirmLabel: `確認${dir}`,
        });
        if (!ok) return;
      }
      setOrderFeedback({ price, action, status: 'pending' });
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);

      const basePayload = {
        symbol: targetSymbol, price, action,
        order_type: orderType, price_type: effPriceType, order_cond: orderCond, order_lot: orderLot,
      };

      // 送單核心抽到 utils/orderExec.placeOrderWithRiskConfirm（Sprint D，與 MiniDOM 宮格共用）：
      // POST + 後端 409 CONFIRM_REQUIRED 確認重送。回傳 true=已下單, false=使用者拒絕確認。
      // C3：首發一律不帶 confirm（一般確認框不授權跳過後端 WARNING）；一旦某一筆經 409
      // danger 框取得風控授權，confirmGranted=true，拆單後續批次沿用、不再重複詢問。
      let confirmGranted = false;
      const sendOrder = async (qty: number): Promise<boolean> => {
        const outcome = await placeOrderWithRiskConfirm({ ...basePayload, qty }, confirm, confirmGranted);
        if (outcome.confirmGranted) confirmGranted = true;
        if (!outcome.placed) toast.info('已取消下單');
        return outcome.placed;
      };

      try {
        let placedCount = 0;
        let placedQty = 0; // 實際送出的總口數（拆單時逐批累計）
        // F2：拆單中止旗標 hoist 到 try 範圍，讓下方「成功回饋」能據此排除中止情境。
        let abortedByUser = false;
        if (splitCfg.enabled && orderValue > splitCfg.threshold) {
          const lots = splitOrders(orderValue, splitCfg.minPerLot, splitCfg.maxPerLot);
          splitAbortRef.current = false;
          setSplitProgress({ sent: 0, total: lots.length, aborted: false });
          for (let i = 0; i < lots.length; i++) {
            // 每筆送出前檢查中止旗標（UI 的「中止」按鈕）
            if (splitAbortRef.current) { abortedByUser = true; break; }
            const ok = await sendOrder(lots[i]);
            if (!ok) break; // 使用者拒絕確認 → 不再送出剩餘批次
            placedCount += 1;
            placedQty += lots[i];
            setSplitProgress({ sent: placedCount, total: lots.length, aborted: false });
            if (i < lots.length - 1) {
              await randomDelay(splitCfg.minDelay, splitCfg.maxDelay);
            }
          }
          if (abortedByUser) {
            setSplitProgress({ sent: placedCount, total: lots.length, aborted: true });
            toast.info(`已中止，完成 ${placedCount}/${lots.length}`);
          }
        } else {
          if (await sendOrder(orderValue)) { placedCount = 1; placedQty = orderValue; }
        }

        if (placedCount > 0) {
          // 真實已下單 → 一律對帳（中止與否都要，殘留掛單/部位需即時反映）
          scheduleOrderRefresh();
          // F2：使用者中止拆單時，不再播「成功」回饋（綠閃 / 音效 / 成功 toast），
          // 只保留上方的「已中止 x/y」提示，並清掉 pending 閃爍。
          if (!abortedByUser) {
            setOrderFeedback({ price, action, status: 'success' });
            playSound('order_placed');
            const dirZh = action === 'Buy' ? '買' : '賣';
            const atLabel = (effPriceType === 'MKT' || effPriceType === 'MKP') ? '市價' : price;
            toast.success(`${dirZh} ${placedQty} @ ${atLabel} ✓`);
          } else {
            setOrderFeedback(null);
          }
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
      feedbackTimerRef.current = setTimeout(() => setOrderFeedback(null), 800);
    } finally {
      isOrderPendingRef.current = false;
      // 中止態短暫保留（~1.8s）讓「已中止 x/y」渲染得出來；其餘情況立即清。
      setSplitProgress((p) => {
        if (p && p.aborted) {
          if (splitClearTimerRef.current) clearTimeout(splitClearTimerRef.current);
          splitClearTimerRef.current = setTimeout(() => setSplitProgress(null), 1800);
          return p;
        }
        return null;
      });
    }
  }, [targetSymbol, orderValue, orderType, priceType, orderCond, orderLot, splitCfg, scheduleOrderRefresh, toast, confirm, settings.confirmations.placeOrder, settings.isCombatMode, chaseMode, settings.chase, refreshSmartOrders]);

  const handleCancelOrder = useCallback(async (action: 'Buy' | 'Sell', price?: number) => {
    // 刪單確認：戰鬥模式跳過；否則若開啟刪單確認則先問
    if (settings.confirmations.cancelOrder && !settings.isCombatMode) {
      const side = action === 'Buy' ? '買方' : '賣方';
      const at = price != null ? ` @ ${price}` : '（全部）';
      const ok = await confirm({
        title: '刪單確認',
        message: `確認刪除 ${targetSymbol} ${side}掛單${at}？`,
        confirmLabel: '確認刪單',
      });
      if (!ok) return;
    }
    try {
      // P0-2：price 有值 → 後端只撤該精確價位（cancel_orders_by_action_price），
      // 不再誤刪整側含手動單；回傳 cancelled = 實際撤單數，據實回報（撤 0 也不當成功）。
      const res = await apiClient.post('/cancel_all', { symbol: targetSymbol, action, price });
      scheduleOrderRefresh();
      playSound('cancel_order');
      const cancelled = Number((res?.data as { cancelled?: number } | undefined)?.cancelled ?? NaN);
      if (Number.isFinite(cancelled)) {
        const sideZh = action === 'Buy' ? '買方' : '賣方';
        const atZh = price != null ? ` @ ${price}` : '';
        if (cancelled > 0) {
          toast.success(`已撤 ${cancelled} 筆${sideZh}掛單${atZh}`);
        } else if (price != null) {
          // 指定價位卻撤到 0 筆 → 單已不在（已成交/已撤），如實告知，不假裝成功
          toast.info(`該價位已無${sideZh}掛單可撤${atZh}`);
        }
      }
    } catch (e) {
      handleApiError(e, '刪單失敗');
    }
  }, [targetSymbol, scheduleOrderRefresh, handleApiError, confirm, toast, settings.confirmations.cancelOrder, settings.isCombatMode]);

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
    let oldPrice = 0;
    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (data.action !== tgtAction) return;

      oldPrice = parseFloat(data.oldPriceStr);
      if (oldPrice === newPrice) return;

      const oldKey = Math.round(oldPrice * 100);
      const qty = (tgtAction === 'Buy' ? workingBuyMap : workingSellMap).get(oldKey) || 0;
      if (qty <= 0) return;

      // Item 6：送出期間舊價位標籤顯示「改價中」（虛線 / 半透明）
      setReplacingOrder({ price: oldPrice, action: tgtAction });

      await apiClient.post('/update_order', {
        symbol: targetSymbol,
        action: tgtAction,
        old_price: oldPrice,
        new_price: newPrice,
        qty: qty
      });

      playSound('order_replaced');
      toast.success(`改價成功：${tgtAction === 'Buy' ? '買' : '賣'} ${qty} 由 ${oldPrice} → ${newPrice}`);
      scheduleOrderRefresh();
    } catch (e) {
      const err = normalizeApiError(e);
      if (err.code === 'ORDER_NOT_FOUND') {
        // 掛單其實已不存在（外部已刪/已成交）→ 立即對帳，清掉 ladder 上的殘留掛單徽章
        scheduleOrderRefresh();
      }
      // 失敗：清掉「改價中」樣式即恢復原價位標籤（後端未改單，掛單仍在原價）
      handleApiError(e, '改單失敗');
    } finally {
      setReplacingOrder(null);
    }
  }, [targetSymbol, workingBuyMap, workingSellMap, scheduleOrderRefresh, handleApiError, toast]);

  // ── UX 批次 4 Item 8：追買 / 追賣 / 市價熱鍵 ────────────────
  // 追買＝以「賣一價」掛買（吃最優賣方流動性）；追賣＝以「買一價」掛賣。
  // 都走 handlePlaceOrder → 沿用戰鬥模式 / 確認流 / 風控 409 confirm 全套。
  const handleChaseOrder = useCallback(async (action: 'Buy' | 'Sell') => {
    // P3：報價假死（isStale）時盤口第一檔是凍結值 → 追買/追賣可能貼到過期價，直接擋。
    if (isStale) {
      toast.warn('報價已停止更新，暫停追價（等連線恢復再試）');
      return;
    }
    const askArr = bidAsk?.AskPrice || [];
    const bidArr = bidAsk?.BidPrice || [];
    const px = action === 'Buy' ? Number(askArr[0] || 0) : Number(bidArr[0] || 0);
    if (!(px > 0)) {
      toast.warn(action === 'Buy' ? '無賣一價，無法追買' : '無買一價，無法追賣');
      return;
    }
    await handlePlaceOrder(px, action);
  }, [bidAsk, handlePlaceOrder, toast, isStale]);

  // 市價單熱鍵：price=0 + price_type MKT（不改使用者的 priceType 選單狀態）
  const handleMarketOrder = useCallback(async (action: 'Buy' | 'Sell') => {
    await handlePlaceOrder(0, action, 'MKT');
  }, [handlePlaceOrder]);

  return {
    qData, bData, currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice, isSimulation,
    isStale, flashDir,
    orderValue, setOrderValue, orderType, setOrderType, priceType, setPriceType,
    orderCond, setOrderCond, orderLot, setOrderLot,
    isSyncing, handleManualSync,
    workingBuyMap, workingSellMap, currentPosition,
    handlePlaceOrder, handleCancelOrder, handleAddStopOrder, handleDropOrder,
    handleChaseOrder, handleMarketOrder,
    chaseMode, setChaseMode,
    orderFeedback, replacingOrder, smartOrders,
    splitProgress, abortSplit,
    targetSymbol, accountSummary, accounts, activeAccount, selectAccount,
    hotkeys,
    accountEquity,
  };
}
