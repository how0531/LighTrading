import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { apiClient, normalizeApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { splitOrders, randomDelay } from '../utils/splitOrder';
import { symbolMatches } from '../utils/instrument';
import { resolveLots } from '../utils/sizing';
import { useAccountEquity } from './useAccountEquity';
import type { WorkingOrder } from '../contexts/TradingContext';
import { getMultiplier } from '../types';

export function useDOMLogic() {
  const {
    quote, bidAsk, targetSymbol, accountSummary, isStale,
    workingOrders, refreshOrders,
    smartOrders, refreshSmartOrders,
    accounts, activeAccount, selectAccount
  } = useTradingContext();
  const { toast } = useToast();

  const [orderValue, setOrderValue] = useState(1);
  const [orderType, setOrderType] = useState('ROD');
  const [priceType, setPriceType] = useState('LMT');
  const [orderCond, setOrderCond] = useState('Cash');
  const [orderLot, setOrderLot] = useState('Common');
  const [isSyncing, setIsSyncing] = useState(false);

  // 設定
  const { settings } = useSettings();
  const { hotkeys, splitOrder: splitCfg } = settings;

  // 下單回饋狀態
  const [orderFeedback, setOrderFeedback] = useState<{ price: number; action: string; status: 'pending' | 'success' | 'error' } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isOrderPendingRef = useRef(false);

  // 閃爍計時器
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  const tableRef = useRef<HTMLDivElement>(null);
  const hasScrolled = useRef(false);

  const qData = quote || {};
  const bData = bidAsk || {};

  // ★ R9：把 6 個獨立 setState 合併為 sticky-reducer。
  // 之前每次 qData 更新會觸發 6 次 setState（React 18+ batch 仍會 schedule reconcile），
  // 且 effect 依賴整個 qData 物件，等同每 tick 都重跑。改為單一 useMemo + useRef 黏滯：
  // - 報價欄位只在 > 0 時覆寫舊值（保留 Snapshot 帶來的靜態欄位）
  // - 輸出物件 reference 只在實際變化時換新，避免無謂 re-render
  const stickyDerivedRef = useRef<{
    currentPrice: number; refPrice: number;
    limitUp: number; limitDown: number;
    highPrice: number; lowPrice: number;
  }>({ currentPrice: 0, refPrice: 0, limitUp: 0, limitDown: 0, highPrice: 0, lowPrice: 0 });

  const derived = useMemo(() => {
    const q = qData as any;
    const prev = stickyDerivedRef.current;
    const next = {
      currentPrice: q?.Price     > 0 ? q.Price     : prev.currentPrice,
      refPrice:     q?.Reference > 0 ? q.Reference : prev.refPrice,
      limitUp:      q?.LimitUp   > 0 ? q.LimitUp   : prev.limitUp,
      limitDown:    q?.LimitDown > 0 ? q.LimitDown : prev.limitDown,
      highPrice:    q?.High      > 0 ? q.High      : prev.highPrice,
      lowPrice:     q?.Low       > 0 ? q.Low       : prev.lowPrice,
    };
    // 只在實際變化時才更新 ref + 給出新 object（穩定下游 memo）
    if (
      next.currentPrice === prev.currentPrice && next.refPrice === prev.refPrice &&
      next.limitUp === prev.limitUp && next.limitDown === prev.limitDown &&
      next.highPrice === prev.highPrice && next.lowPrice === prev.lowPrice
    ) {
      return prev;
    }
    stickyDerivedRef.current = next;
    return next;
  }, [qData]);

  const { currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice } = derived;

  // 切換商品時清掉 sticky 快取，避免上個商品的 LimitUp/LimitDown 殘留
  useEffect(() => {
    stickyDerivedRef.current = { currentPrice: 0, refPrice: 0, limitUp: 0, limitDown: 0, highPrice: 0, lowPrice: 0 };
  }, [targetSymbol]);

  // Sprint 20：切換商品時若 settings.qtyBySymbol 有對應預設口數，自動套用；
  //   找不到就保持當前值。只在 sizing.mode === 'lots' 時生效。
  useEffect(() => {
    if (settings.sizing.mode !== 'lots') return;
    const map = settings.qtyBySymbol;
    if (!targetSymbol || !map) return;
    const preset = map[targetSymbol.toUpperCase()];
    if (preset && preset > 0) setOrderValue(preset);
  }, [targetSymbol, settings.qtyBySymbol, settings.sizing.mode]);

  // Sprint 32 QA fix：從 amount/% 模式「切回」lots 的瞬間，orderValue 會殘留
  //   前一模式依價格換算出的張數（例：8 張），對 lots 使用者是非預期下單量。
  //   只在 mode 真的由非 lots → lots 轉換時校正：有 per-symbol 預設就套用，否則回 1。
  const prevSizingModeRef = useRef(settings.sizing.mode);
  useEffect(() => {
    const mode = settings.sizing.mode;
    const prev = prevSizingModeRef.current;
    prevSizingModeRef.current = mode;
    if (mode === 'lots' && prev !== 'lots') {
      const preset = settings.qtyBySymbol?.[(targetSymbol || '').toUpperCase()];
      setOrderValue(preset && preset > 0 ? preset : 1);
    }
  }, [settings.sizing.mode, settings.qtyBySymbol, targetSymbol]);

  // Sprint 28：智慧 sizing — 金額 / % 權益模式下，依當前價自動重算 orderValue
  const accountEquity = useAccountEquity();
  useEffect(() => {
    const sz = settings.sizing;
    if (sz.mode === 'lots') return;
    const price = currentPrice || refPrice;
    if (!price || !targetSymbol) return;
    const multiplier = getMultiplier(targetSymbol);
    const value = sz.mode === 'amount' ? sz.amount : sz.equityPct;
    const lots = resolveLots(sz.mode, value, { price, multiplier, equity: accountEquity });
    if (lots > 0) {
      setOrderValue((prev) => (prev === lots ? prev : lots));
    }
  }, [settings.sizing, currentPrice, refPrice, targetSymbol, accountEquity]);

  const isSimulation = accountSummary?.is_simulation ?? true;

  const currentPriceRef = useRef(currentPrice);
  const refPriceRef = useRef(refPrice);
  useEffect(() => { currentPriceRef.current = currentPrice; }, [currentPrice]);
  useEffect(() => { refPriceRef.current = refPrice; }, [refPrice]);

  // --- 掛單查找表 ---
  const workingBuyMap = useMemo(() => {
    const m = new Map<number, number>();
    if (!targetSymbol) return m;
    workingOrders
      .filter((o: WorkingOrder) => o.action === 'Buy' && symbolMatches(targetSymbol, o.symbol))
      .forEach((o: WorkingOrder) => {
        const key = Math.round(o.price * 100);
        m.set(key, (m.get(key) || 0) + (o.qty - o.filled_qty));
      });
    return m;
  }, [workingOrders, targetSymbol]);

  const workingSellMap = useMemo(() => {
    const m = new Map<number, number>();
    if (!targetSymbol) return m;
    workingOrders
      .filter((o: WorkingOrder) => o.action === 'Sell' && symbolMatches(targetSymbol, o.symbol))
      .forEach((o: WorkingOrder) => {
        const key = Math.round(o.price * 100);
        m.set(key, (m.get(key) || 0) + (o.qty - o.filled_qty));
      });
    return m;
  }, [workingOrders, targetSymbol]);

  // --- 報價閃爍邏輯 ---
  const prevPriceRef = useRef<number>(currentPrice);
  const [flashDir, setFlashDir] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (currentPrice !== prevPriceRef.current) {
      if (currentPrice > prevPriceRef.current) setFlashDir('up');
      else if (currentPrice < prevPriceRef.current) setFlashDir('down');
      prevPriceRef.current = currentPrice;
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlashDir(null), 300);
    }
  }, [currentPrice]);

  // --- 手動同步按鈕 ---
  const handleManualSync = async () => {
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
  };

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

    try {
      if (splitCfg.enabled && orderValue > splitCfg.threshold) {
        const reqs = [];
        const lots = splitOrders(orderValue, splitCfg.minPerLot, splitCfg.maxPerLot);
        for (let i = 0; i < lots.length; i++) {
          reqs.push(apiClient.post('/place_order', {
            symbol: targetSymbol, price, action, qty: lots[i], order_type: orderType, price_type: priceType, order_cond: orderCond, order_lot: orderLot
          }));
          if (i < lots.length - 1) {
            await randomDelay(splitCfg.minDelay, splitCfg.maxDelay);
          }
        }
        await Promise.all(reqs);
      } else {
        await apiClient.post('/place_order', {
          symbol: targetSymbol, price, action, qty: orderValue,
          order_type: orderType, price_type: priceType, order_cond: orderCond, order_lot: orderLot
        });
      }
      setOrderFeedback({ price, action, status: 'success' });
      setTimeout(refreshOrders, 200);
      try {
        const audio = new Audio('/sounds/order_placed.mp3');
        audio.volume = 0.5;
        audio.play().catch(() => { /* 瀏覽器音效政策 */ });
      } catch { /* noop */ }
    } catch (e) {
      const err = normalizeApiError(e);
      setOrderFeedback({ price, action, status: 'error' });
      // RISK_WARNING → 提供「仍要下單」的 action 按鈕（Sprint 1 後端可回 warning level）
      if (err.level === 'warning') {
        toast.warn(err.user_msg, {
          actionLabel: '仍要下單',
          onAction: () => {
            // 未來可附 confirm 旗標到後端；目前 warning 後端尚未支援 bypass，提示即可
            toast.info('已收到，請手動再次點擊下單以確認');
          },
        });
      } else {
        toast.error(err.user_msg || '下單失敗');
      }
    }
    isOrderPendingRef.current = false;
    feedbackTimerRef.current = setTimeout(() => setOrderFeedback(null), 800);
  }, [targetSymbol, orderValue, orderType, priceType, orderCond, orderLot, splitCfg, refreshOrders, toast]);

  const handleCancelOrder = useCallback(async (action: 'Buy' | 'Sell', price?: number) => {
    try {
      await apiClient.post('/cancel_all', { symbol: targetSymbol, action, price });
      setTimeout(refreshOrders, 200);
      try {
        const audio = new Audio('/sounds/cancel_order.mp3');
        audio.volume = 0.5;
        audio.play().catch(() => { /* noop */ });
      } catch { /* noop */ }
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '刪單失敗');
    }
  }, [targetSymbol, refreshOrders, toast]);

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
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '新增觸價單失敗');
    }
  }, [targetSymbol, orderValue, refreshSmartOrders, toast]);

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

      try {
        const audio = new Audio('/sounds/order_replaced.mp3');
        audio.volume = 0.5;
        audio.play().catch(() => { /* noop */ });
      } catch { /* noop */ }
      setTimeout(refreshOrders, 200);
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '改單失敗');
    }
  }, [targetSymbol, workingBuyMap, workingSellMap, refreshOrders, toast]);

  return {
    qData, bData, currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice, isSimulation,
    isStale, tableRef, hasScrolled, flashDir,
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
