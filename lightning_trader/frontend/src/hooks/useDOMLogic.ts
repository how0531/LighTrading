import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { apiClient } from '../api/client';
import { splitOrders, randomDelay } from '../utils/splitOrder';
import type { WorkingOrder } from '../contexts/TradingContext';
import { getMultiplier } from '../types';

export function useDOMLogic() {
  const {
    quote, bidAsk, targetSymbol, accountSummary, isStale,
    workingOrders, refreshOrders,
    smartOrders, refreshSmartOrders,
    accounts, activeAccount, selectAccount
  } = useTradingContext();

  const [orderValue, setOrderValue] = useState(1);
  const [orderType, setOrderType] = useState('ROD');
  const [priceType, setPriceType] = useState('LMT');
  const [orderCond, setOrderCond] = useState('Cash');
  const [orderLot, setOrderLot] = useState('Common');
  const [calcAmount, setCalcAmount] = useState<number | ''>('');
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
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [refPrice, setRefPrice] = useState<number>(0);
  const [limitUp, setLimitUp] = useState<number>(0);
  const [limitDown, setLimitDown] = useState<number>(0);
  const [highPrice, setHighPrice] = useState<number>(0);
  const [lowPrice, setLowPrice] = useState<number>(0);

  // 當 qData 更新時，同步更新報價資訊
  useEffect(() => {
    if (qData) {
      const q = qData as any; // Type assertion to bypass strict checking
      if (q.Price > 0) setCurrentPrice(q.Price);
      if (q.Reference > 0) setRefPrice(q.Reference);
      if (q.LimitUp > 0) setLimitUp(q.LimitUp);
      if (q.LimitDown > 0) setLimitDown(q.LimitDown);
      if (q.High > 0) setHighPrice(q.High);
      if (q.Low > 0) setLowPrice(q.Low);
    }
  }, [qData]);

  const isSimulation = accountSummary?.is_simulation ?? true;

  const currentPriceRef = useRef(currentPrice);
  const refPriceRef = useRef(refPrice);
  useEffect(() => { currentPriceRef.current = currentPrice; }, [currentPrice]);
  useEffect(() => { refPriceRef.current = refPrice; }, [refPrice]);

  // --- 掛單查找表 ---
  const workingBuyMap = useMemo(() => {
    const m = new Map<number, number>();
    if (!targetSymbol) return m;
    const code = targetSymbol.replace(/\D/g, '');
    workingOrders
      .filter((o: WorkingOrder) => o.action === 'Buy' && (o.symbol === targetSymbol || (code && o.symbol.includes(code))))
      .forEach((o: WorkingOrder) => {
        const key = Math.round(o.price * 100);
        m.set(key, (m.get(key) || 0) + (o.qty - o.filled_qty));
      });
    return m;
  }, [workingOrders, targetSymbol]);

  const workingSellMap = useMemo(() => {
    const m = new Map<number, number>();
    if (!targetSymbol) return m;
    const code = targetSymbol.replace(/\D/g, '');
    workingOrders
      .filter((o: WorkingOrder) => o.action === 'Sell' && (o.symbol === targetSymbol || (code && o.symbol.includes(code))))
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
    const code = targetSymbol.replace(/\D/g, '');
    return accountSummary.positions.find((p: any) =>
      p.symbol === targetSymbol || (code && p.symbol.includes(code))
    ) || null;
  }, [accountSummary.positions, targetSymbol]);

  // --- 金額換算 ---
  const handleAmountConvert = useCallback(() => {
    const cp = currentPrice || refPrice;
    if (cp > 0 && typeof calcAmount === 'number' && calcAmount > 0) {
      const multiplier = getMultiplier(targetSymbol || '');
      const lots = Math.floor(calcAmount / (cp * multiplier));
      if (lots > 0) setOrderValue(lots);
    }
  }, [currentPrice, refPrice, calcAmount, targetSymbol]);

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
      const audio = new Audio('/sounds/order_placed.mp3');
      audio.volume = 0.5;
      audio.play();
    } catch (e) {
      console.error('[DOMPanel] 快速下單失敗:', e);
      setOrderFeedback({ price, action, status: 'error' });
    }
    isOrderPendingRef.current = false;
    feedbackTimerRef.current = setTimeout(() => setOrderFeedback(null), 800);
  }, [targetSymbol, orderValue, orderType, priceType, orderCond, orderLot, splitCfg, refreshOrders]);

  const handleCancelOrder = useCallback(async (action: 'Buy' | 'Sell', price?: number) => {
    try {
      await apiClient.post('/cancel_all', { symbol: targetSymbol, action, price });
      setTimeout(refreshOrders, 200);
      const audio = new Audio('/sounds/cancel_order.mp3');
      audio.volume = 0.5;
      audio.play();
    } catch (e) { console.error(e); }
  }, [targetSymbol, refreshOrders]);

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
      setTimeout(() => refreshSmartOrders(targetSymbol), 200);
    } catch (err) {
      console.error('Add stop order failed:', err);
    }
  }, [targetSymbol, orderValue, refreshSmartOrders]);

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

      const audio = new Audio('/sounds/order_replaced.mp3');
      audio.volume = 0.5;
      audio.play();
      setTimeout(refreshOrders, 200);
    } catch (err) { console.error('改單失敗:', err); }
  }, [targetSymbol, workingBuyMap, workingSellMap, refreshOrders]);

  return {
    qData, bData, currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice, isSimulation,
    isStale, tableRef, hasScrolled, flashDir,
    orderValue, setOrderValue, orderType, setOrderType, priceType, setPriceType,
    orderCond, setOrderCond, orderLot, setOrderLot, calcAmount, setCalcAmount,
    isSyncing, handleManualSync,
    workingBuyMap, workingSellMap, currentPosition,
    handlePlaceOrder, handleCancelOrder, handleAddStopOrder, handleDropOrder,
    handleAmountConvert, // Added missing export
    orderFeedback, smartOrders,
    targetSymbol, accountSummary, accounts, activeAccount, selectAccount,
    hotkeys
  };
}
