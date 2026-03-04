import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { apiClient } from '../api/client';
import { useSettings } from '../contexts/SettingsContext';
import { splitOrders, randomDelay } from '../utils/splitOrder';
import type { QuoteData, BidAskData } from '../types';

// 委託單介面
interface WorkingOrder {
  symbol: string;
  action: string;
  price: number;
  qty: number;
  filled_qty: number;
  status: string;
}

// --- 台灣證交所正確 Tick 級距表 ---
const getTickSize = (price: number, symbol: string): number => {
  const sym = symbol.toUpperCase();
  // 期貨合約：台指期(TXF/MXF)跳動單位固定 1 點
  if (sym.startsWith('TXF') || sym.startsWith('MXF') || sym.startsWith('TX') || sym.startsWith('MX')) return 1;
  // 股票跳價級距（台灣證交所規定）
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.10;
  if (price < 500) return 0.50;
  if (price < 1000) return 1.00;
  return 5.00;
};

// 精確四捨五入避免浮點漂移
const round2 = (n: number): number => Math.round(n * 100) / 100;

// 格式化價格小數位數
const formatPrice = (price: number, symbol: string): string => {
  const sym = symbol.toUpperCase();
  if (sym.startsWith('TXF') || sym.startsWith('MXF') || sym.startsWith('TX') || sym.startsWith('MX')) {
    return price.toFixed(0);
  }
  if (price >= 1000) return price.toFixed(0);
  if (price >= 100) return price.toFixed(1);
  return price.toFixed(2);
};

// 商品乘數：股票=1000, 大台=200, 小台=50
const getMultiplier = (symbol: string): number => {
  const sym = symbol.toUpperCase();
  if (sym.startsWith('MXF') || sym.includes('小台')) return 50;
  if (sym.startsWith('TXF') || sym.includes('大台')) return 200;
  return 1000;
};

const DOMPanel: React.FC = () => {
  const context = useTradingContext();
  const { 
    quote, bidAsk, targetSymbol, accountSummary, isStale,
    accounts = [], activeAccount, selectAccount = async () => {} 
  } = context;
  const [orderValue, setOrderValue] = useState(1);
  const [orderType, setOrderType] = useState('ROD');
  const [calcAmount, setCalcAmount] = useState<number | ''>('');
  const [isSyncing, setIsSyncing] = useState(false);

  // 設定
  const { settings } = useSettings();
  const { hotkeys, splitOrder: splitCfg } = settings;
  
  // 下單回饋狀態 (用 ref 追蹤 pending 避免 stale closure)
  const [orderFeedback, setOrderFeedback] = useState<{price: number; action: string; status: 'pending'|'success'|'error'} | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isOrderPendingRef = useRef(false);

  // 閃爍計時器 ref (避免 unmount 後觸發 setState)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Unmount 時統一清理所有計時器
  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  // 掛單查詢
  const [workingOrders, setWorkingOrders] = useState<WorkingOrder[]>([]);

  // 自動捲動到當前價
  const tableRef = useRef<HTMLDivElement>(null);
  const hasScrolled = useRef(false);
  
  // 具型別的報價資料（消除 any）
  const qData: Partial<QuoteData> = quote || {};
  const bData: Partial<BidAskData> = bidAsk || {};
  const currentPrice = qData.Price || 0;
  const refPrice = qData.Reference || 0;
  const limitUp = qData.LimitUp || 0;
  const limitDown = qData.LimitDown || 0;
  const highPrice = qData.High || 0;
  const lowPrice = qData.Low || 0;
  const isSimulation = accountSummary.is_simulation ?? true;

  // 用 ref 追蹤高頻變動的價格，供 useCallback 穩定引用
  const currentPriceRef = useRef(currentPrice);
  const refPriceRef = useRef(refPrice);
  useEffect(() => { currentPriceRef.current = currentPrice; }, [currentPrice]);
  useEffect(() => { refPriceRef.current = refPrice; }, [refPrice]);

  // Debug Log: 追蹤資料進來的情況
  useEffect(() => {
    if (bData && bData.Symbol) {
      // console.log(`[DOMPanel] BidAsk updated for ${bData.Symbol}:`, bData);
    }
  }, [bData]);

  // --- 定期拉取掛單 ---
  useEffect(() => {
    const fetchOrders = async () => {
      try {
        const res = await apiClient.get('/order_history');
        const orders: WorkingOrder[] = (res.data || []).filter(
          (o: any) => o.status === 'PendingSubmit' || o.status === 'PreSubmitted' || o.status === 'Submitted' || o.status === 'PartFilled'
        );
        setWorkingOrders(orders);
      } catch { /* 靜默 */ }
    };
    fetchOrders();
    const interval = setInterval(fetchOrders, 3000);
    return () => clearInterval(interval);
  }, []);

  // --- 掛單查找表 ---
  const workingBuyMap = useMemo(() => {
    const m = new Map<number, number>();
    if (!targetSymbol) return m;
    const code = targetSymbol.replace(/\D/g, '');
    workingOrders
      .filter(o => o.action === 'Buy' && (o.symbol === targetSymbol || o.symbol.includes(code)))
      .forEach(o => {
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
      .filter(o => o.action === 'Sell' && (o.symbol === targetSymbol || o.symbol.includes(code)))
      .forEach(o => {
        const key = Math.round(o.price * 100);
        m.set(key, (m.get(key) || 0) + (o.qty - o.filled_qty));
      });
    return m;
  }, [workingOrders, targetSymbol]);

  // --- 報價閃爍邏輯 (計時器以 ref 管理避免 unmount leak) ---
  const prevPriceRef = useRef<number>(currentPrice);
  const [flashDir, setFlashDir] = useState<'up' | 'down' | 'none'>('none');

  useEffect(() => {
    if (currentPrice > 0 && prevPriceRef.current > 0) {
      if (currentPrice > prevPriceRef.current) {
        setFlashDir('up');
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashDir('none'), 200);
      } else if (currentPrice < prevPriceRef.current) {
        setFlashDir('down');
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashDir('none'), 200);
      }
    }
    prevPriceRef.current = currentPrice;
  }, [currentPrice]);

  // --- 部位匹配 ---
  const currentPosition = useMemo(() => {
    const positions = accountSummary.positions || [];
    if (!targetSymbol || positions.length === 0) return null;
    const targetCode = targetSymbol.trim().toUpperCase().replace(/\D/g, ''); 
    const allMatches = positions.filter((p) => {
      if (!p.symbol) return false;
      const pSymbol = String(p.symbol).trim().toUpperCase();
      return pSymbol === targetSymbol.toUpperCase() || pSymbol.includes(targetCode);
    });
    if (allMatches.length === 0) return null;
    const totalQty = allMatches.reduce((sum, p) => sum + p.qty, 0);
    const avgPrice = allMatches.reduce((sum, p) => sum + (p.price * p.qty), 0) / (totalQty || 1);
    const totalBackendPnl = allMatches.reduce((sum, p) => sum + (p.pnl || 0), 0);
    return { ...allMatches[0], qty: totalQty, price: avgPrice, backendPnl: totalBackendPnl };
  }, [accountSummary.positions, targetSymbol]);

  const netQty = currentPosition ? (currentPosition.direction === 'Buy' ? currentPosition.qty : -currentPosition.qty) : 0;
  
  // --- 損益重算 (使用 getMultiplier 工具函式) ---
  const realtimePnL = useMemo(() => {
    if (netQty === 0 || !currentPosition) return 0;
    const cp = currentPrice || refPrice;
    if (cp > 0 && currentPosition.price > 0) {
      const multiplier = getMultiplier(targetSymbol || '');
      const localPnl = Math.round((cp - currentPosition.price) * netQty * multiplier);
      if (localPnl !== 0) return localPnl;
    }
    return currentPosition.backendPnl || 0;
  }, [currentPrice, refPrice, currentPosition, netQty, targetSymbol]);

  // --- ★ 核心：以當前價為中心展開 500 檔價格 ---
  const fullPrices = useMemo(() => {
    // 需要至少有 reference price 才能算
    const base = currentPrice || refPrice;
    if (base <= 0) return [];

    const up = limitUp > 0 ? limitUp : round2(base * 1.1);
    const down = limitDown > 0 ? limitDown : round2(base * 0.9);
    const sym = targetSymbol || '';

    // 往上推 250 檔
    const upper: number[] = [];
    let pUp = base;
    while (pUp <= up && upper.length < 250) {
      const tick = getTickSize(pUp, sym);
      pUp = round2(pUp + tick);
      if (pUp <= up) upper.push(pUp);
    }
    upper.reverse();

    // 往下推 250 檔 (包含 base 本身)
    const lower: number[] = [base];
    let pDown = base;
    while (pDown >= down && lower.length < 250) {
      const tick = getTickSize(pDown, sym);
      pDown = round2(pDown - tick);
      if (pDown >= down) lower.push(pDown);
    }

    return [...upper, ...lower];
  }, [currentPrice, refPrice, limitUp, limitDown, targetSymbol]);

  // --- 自動捲動到當前價（首次載入或手動觸發） ---
  const scrollToCurrentPrice = useCallback(() => {
    if (currentPrice > 0) {
      // 使用整數 pKey（與 data-price 屬性相同）避免浮點誤差
      const pKey = Math.round(currentPrice * 100);
      const row = document.querySelector(`[data-price="${pKey}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [currentPrice]);

  useEffect(() => {
    if (currentPrice > 0 && fullPrices.length > 0 && !hasScrolled.current) {
      hasScrolled.current = true;
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        scrollToCurrentPrice();
      }, 100);
    }
  }, [currentPrice, fullPrices, scrollToCurrentPrice]);

  // 換商品時重置捲動
  useEffect(() => {
    hasScrolled.current = false;
  }, [targetSymbol]);

  // --- BidAsk 查找表 ---
  const bidMap = useMemo(() => {
    const m = new Map<number, number>();
    const prices = bData.BidPrice || [];
    const vols = bData.BidVolume || [];
    for (let i = 0; i < prices.length; i++) {
      m.set(Math.round(prices[i] * 100), vols[i] || 0);
    }
    return m;
  }, [bData]);

  const askMap = useMemo(() => {
    const m = new Map<number, number>();
    const prices = bData.AskPrice || [];
    const vols = bData.AskVolume || [];
    for (let i = 0; i < prices.length; i++) {
      m.set(Math.round(prices[i] * 100), vols[i] || 0);
    }
    return m;
  }, [bData]);

  // --- Diff BidAsk 查找表 ---
  const diffBidMap = useMemo(() => {
    const m = new Map<number, number>();
    const prices = bData.BidPrice || [];
    const diffs = bData.DiffBidVol || [];
    for (let i = 0; i < prices.length; i++) {
      m.set(Math.round(prices[i] * 100), diffs[i] || 0);
    }
    return m;
  }, [bData]);

  const diffAskMap = useMemo(() => {
    const m = new Map<number, number>();
    const prices = bData.AskPrice || [];
    const diffs = bData.DiffAskVol || [];
    for (let i = 0; i < prices.length; i++) {
      m.set(Math.round(prices[i] * 100), diffs[i] || 0);
    }
    return m;
  }, [bData]);

  // --- 累計 BidAsk 查找表 (Cumulative Depth) ---
  const cumBidMap = useMemo(() => {
    const m = new Map<number, number>();
    const prices = bData.BidPrice || [];
    const vols = bData.BidVolume || [];
    let cum = 0;
    for (let i = 0; i < prices.length; i++) {
      if (prices[i] > 0) {
        cum += (vols[i] || 0);
        m.set(Math.round(prices[i] * 100), cum);
      }
    }
    return m;
  }, [bData]);

  const cumAskMap = useMemo(() => {
    const m = new Map<number, number>();
    const prices = bData.AskPrice || [];
    const vols = bData.AskVolume || [];
    let cum = 0;
    for (let i = 0; i < prices.length; i++) {
      if (prices[i] > 0) {
        cum += (vols[i] || 0);
        m.set(Math.round(prices[i] * 100), cum);
      }
    }
    return m;
  }, [bData]);

  const maxCumVolume = useMemo(() => {
    let max = 1;
    cumBidMap.forEach(v => { if (v > max) max = v; });
    cumAskMap.forEach(v => { if (v > max) max = v; });
    return max;
  }, [cumBidMap, cumAskMap]);

  // --- 下單（含回饋，用 ref 追蹤 pending 避免 stale closure） ---
  const handlePlaceOrder = useCallback(async (price: number, action: 'Buy' | 'Sell') => {
    if (isOrderPendingRef.current || isStale) return;
    isOrderPendingRef.current = true;
    setOrderFeedback({ price, action, status: 'pending' });
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);

    try {
      // ★ 拆單邏輯：啟用且超過閾值時，拆成多筆送出
      if (splitCfg.enabled && orderValue > splitCfg.threshold) {
        const lots = splitOrders(orderValue, splitCfg.minPerLot, splitCfg.maxPerLot);
        for (let i = 0; i < lots.length; i++) {
          await apiClient.post('/place_order', {
            symbol: targetSymbol, price, action, qty: lots[i], order_type: orderType
          });
          if (i < lots.length - 1) {
            await randomDelay(splitCfg.minDelay, splitCfg.maxDelay);
          }
        }
      } else {
        await apiClient.post('/place_order', { 
          symbol: targetSymbol, price, action, qty: orderValue, order_type: orderType 
        });
      }
      setOrderFeedback({ price, action, status: 'success' });
    } catch {
      setOrderFeedback({ price, action, status: 'error' });
    }
    isOrderPendingRef.current = false;
    feedbackTimerRef.current = setTimeout(() => setOrderFeedback(null), 800);
  }, [targetSymbol, orderValue, orderType, splitCfg]);

  // --- 刪單 / 快捷操作 (合併為通用函式) ---
  const handleCancelOrder = useCallback(async (action: 'Buy' | 'Sell') => {
    try { await apiClient.post('/cancel_all', { symbol: targetSymbol, action }); } catch { /* */ }
  }, [targetSymbol]);

  const handleFlatten = useCallback(async () => {
    try { await apiClient.post('/flatten', { symbol: targetSymbol }); } catch { /* */ }
  }, [targetSymbol]);

  const handleReverse = useCallback(async () => {
    try { await apiClient.post('/reverse', { symbol: targetSymbol }); } catch { /* */ }
  }, [targetSymbol]);

  // --- 金額換算張數 (使用 ref 取得最新價格避免頻繁重建) ---
  const handleAmountConvert = useCallback((amountAmt: number | '') => {
      const amt = Number(amountAmt);
      if (amt > 0 && targetSymbol) {
          const cp = currentPriceRef.current > 0 ? currentPriceRef.current : refPriceRef.current;
          if (cp > 0) {
              const multiplier = getMultiplier(targetSymbol);
              const calcQty = Math.floor(amt / (cp * multiplier));
              setOrderValue(Math.max(1, calcQty));
          }
      }
  }, [targetSymbol]);

  const handleManualSync = async () => {
    setIsSyncing(true);
    try { if (activeAccount) await selectAccount(activeAccount); } catch { /* */ }
    finally {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(() => setIsSyncing(false), 1000);
    }
  };

  // ★ 全域快捷鍵監聽
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 若焦點在輸入框，跳過以免干擾打字
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const matched = hotkeys.find(hk => hk.key === e.key);
      if (!matched) return;

      e.preventDefault();
      const cp = currentPriceRef.current;

      switch (matched.action) {
        case 'Buy':
          if (cp > 0) handlePlaceOrder(cp, 'Buy');
          break;
        case 'Sell':
          if (cp > 0) handlePlaceOrder(cp, 'Sell');
          break;
        case 'CancelAll':
          handleCancelOrder('Buy');
          handleCancelOrder('Sell');
          break;
        case 'Flatten':
          handleFlatten();
          break;
        case 'ScrollCenter':
          scrollToCurrentPrice();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeys, handlePlaceOrder, handleCancelOrder, handleFlatten, scrollToCurrentPrice]);

  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-slate-800 bg-[#101623] text-slate-100 relative overflow-hidden shadow-2xl">
      
      {/* Header Section */}
      <div className="flex flex-col shrink-0 shadow-lg z-20 bg-[#1c2331]">
        {/* Row 1: Account, Position, PnL & Status */}
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
                <div className="flex flex-col">
                    <span className="text-[8px] opacity-50 uppercase font-bold mb-0.5">Account</span>
                    <select 
                        value={activeAccount || ''} 
                        onChange={(e) => selectAccount(e.target.value)}
                        className="bg-[#101623] border border-slate-700 rounded text-[11px] font-bold p-1 text-[#D4AF37] outline-none cursor-pointer"
                    >
                        {accounts.map((acc) => (
                            <option key={acc.account_id} value={`${acc.broker_id}-${acc.account_id}`}>{acc.account_id}</option>
                        ))}
                    </select>
                </div>

                <div className={`flex flex-col items-center px-3 py-1 rounded border ${netQty > 0 ? 'bg-red-900/20 border-red-800/50' : netQty < 0 ? 'bg-blue-900/20 border-blue-800/50' : 'bg-slate-800 border-slate-700'}`}>
                    <span className="text-[8px] opacity-50 uppercase font-bold">Position</span>
                    <span className={`text-sm font-black leading-none ${netQty > 0 ? 'text-red-400' : netQty < 0 ? 'text-blue-400' : 'text-slate-500'}`}>
                        {netQty > 0 ? 'LONG' : netQty < 0 ? 'SHORT' : 'FLAT'} {Math.abs(netQty)}
                    </span>
                </div>

                <div className={`flex flex-col items-center px-3 py-1 rounded border ${realtimePnL >= 0 ? 'bg-emerald-900/20 border-emerald-800/50' : 'bg-red-900/20 border-red-800/50'}`}>
                    <span className="text-[8px] opacity-50 uppercase font-bold text-center">PnL</span>
                    <span className={`text-sm font-mono font-black leading-none tabular-nums ${realtimePnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {realtimePnL.toLocaleString()}
                    </span>
                </div>
            </div>
            
            <div className="flex items-center gap-2">
                {/* VWAP 顯示 */}
                {(qData.AvgPrice ?? 0) > 0 && (
                    <div className="flex flex-col items-center px-2 py-1 rounded border border-slate-700 bg-slate-800/60">
                        <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">VWAP</span>
                        <span className={`text-[12px] font-mono font-black tabular-nums leading-none ${
                            currentPrice > (qData.AvgPrice ?? 0) ? 'text-red-400' :
                            currentPrice < (qData.AvgPrice ?? 0) ? 'text-emerald-400' :
                            'text-[#D4AF37]'
                        }`}>
                            {formatPrice(qData.AvgPrice ?? 0, targetSymbol)}
                        </span>
                    </div>
                )}
                
                {/* 每日漲跌停限價 顯示 */}
                {limitUp > 0 && (
                    <div className="flex flex-col items-center px-2 py-1 rounded border border-red-900/50 bg-red-950/30">
                        <span className="text-[8px] font-bold text-red-500/70 uppercase tracking-wider">漲停</span>
                        <span className="text-[12px] font-mono font-black tabular-nums leading-none text-red-500">
                            {formatPrice(limitUp, targetSymbol)}
                        </span>
                    </div>
                )}
                {limitDown > 0 && (
                    <div className="flex flex-col items-center px-2 py-1 rounded border border-emerald-900/50 bg-emerald-950/30">
                        <span className="text-[8px] font-bold text-emerald-500/70 uppercase tracking-wider">跌停</span>
                        <span className="text-[12px] font-mono font-black tabular-nums leading-none text-emerald-500">
                            {formatPrice(limitDown, targetSymbol)}
                        </span>
                    </div>
                )}
                <div className={`px-2 py-1 rounded-md border ${isSimulation ? 'border-yellow-600/50 bg-yellow-900/20' : 'border-emerald-600/50 bg-emerald-900/20'}`}>
                    <p className={`text-[10px] font-black ${isSimulation ? 'text-yellow-500' : 'text-emerald-500'}`}>{isSimulation ? 'SIM' : 'LIVE'}</p>
                </div>
                {fullPrices.length > 0 && (
                    <div className="flex items-center gap-2">
                        <div className="text-[9px] text-slate-500 font-mono">
                            {formatPrice(fullPrices[0], targetSymbol)}~{formatPrice(fullPrices[fullPrices.length - 1], targetSymbol)}
                        </div>
                        <button 
                            onClick={scrollToCurrentPrice}
                            className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] rounded border border-slate-600 transition-colors shadow-sm focus:outline-none"
                            title="捲動至當前價格"
                        >
                            置中
                        </button>
                    </div>
                )}
            </div>
        </div>

        {/* Row 2: Order Settings (Type, Amount to QTY, QTY) */}
        <div className="px-4 py-2 border-b border-slate-800 bg-[#151b26] flex flex-wrap items-center gap-4">
            {/* 委託種類設定 */}
            <div className="flex flex-col gap-0.5">
                <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">Type</span>
                <select 
                    value={orderType} 
                    onChange={(e) => setOrderType(e.target.value)}
                    className="bg-[#101623] border border-slate-700 hover:border-slate-600 rounded text-[11px] font-bold py-1 px-1.5 text-slate-200 outline-none cursor-pointer focus:ring-1 focus:ring-slate-500"
                >
                    <option value="ROD">ROD</option>
                    <option value="IOC">IOC</option>
                    <option value="FOK">FOK</option>
                </select>
            </div>

            {/* 金額換算 */}
            <div className="flex flex-col gap-1">
                <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">Amount to QTY</span>
                <div className="flex items-center gap-1.5">
                    <div className="flex items-center bg-[#101623] rounded border border-slate-700 overflow-hidden focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500">
                        <input 
                            type="number" 
                            placeholder="輸入金額..."
                            value={calcAmount} 
                            onChange={(e) => setCalcAmount(e.target.value ? Number(e.target.value) : '')} 
                            onKeyDown={(e) => e.key === 'Enter' && handleAmountConvert(calcAmount)}
                            className="w-20 sm:w-24 bg-transparent text-right text-slate-300 px-1 py-1 text-[11px] font-mono focus:outline-none placeholder:text-slate-600 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" 
                        />
                        <button 
                            onClick={() => handleAmountConvert(calcAmount)}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white px-2 py-1 text-[10px] font-bold border-l border-slate-700 transition-colors"
                        >
                            換算
                        </button>
                    </div>
                    {/* 快捷金額按鈕 */}
                    <div className="flex gap-1">
                        {[10, 20, 50, 100].map(amt => (
                            <button
                                key={`amt-${amt}`}
                                onClick={() => {
                                    const val = amt * 10000;
                                    setCalcAmount(val);
                                    handleAmountConvert(val);
                                }}
                                className="px-1.5 py-1 bg-[#101623] hover:bg-slate-700 rounded text-[10px] font-bold text-slate-300 transition-colors border border-slate-700 hover:border-slate-500 cursor-pointer shadow-sm"
                            >
                                {amt}W
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* QTY 直播輸入 */}
            <div className="flex flex-col gap-1 ml-1 md:ml-2">
                <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">QTY</span>
                <div className="flex items-center gap-1.5">
                    <div className="flex items-center bg-[#101623] rounded border border-slate-700 p-[1px]">
                        <button onClick={() => setOrderValue(Math.max(1, orderValue-1))} className="w-6 h-6 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors cursor-pointer text-sm font-black leading-none">-</button>
                        <input type="number" value={orderValue} onChange={(e) => setOrderValue(Math.max(1, Number(e.target.value)))} className="w-10 bg-transparent text-center text-[#D4AF37] text-[13px] font-black focus:outline-none tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                        <button onClick={() => setOrderValue(orderValue+1)} className="w-6 h-6 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors cursor-pointer text-sm font-black leading-none">+</button>
                    </div>
                    {/* 快捷數量按鈕 */}
                    <div className="flex gap-1">
                        {[1, 2, 5, 10].map(qty => (
                            <button
                                key={`qty-${qty}`}
                                onClick={() => setOrderValue(qty)}
                                className="px-2 py-1 bg-[#101623] hover:bg-slate-700 rounded text-[10px] font-bold text-[#D4AF37] opacity-80 hover:opacity-100 transition-all border border-slate-700 hover:border-[#D4AF37]/50 cursor-pointer shadow-sm"
                            >
                                {qty}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
      </div>

      {/* Main Table Area */}
      <div ref={tableRef} className="flex-1 overflow-auto bg-black/10 custom-scrollbar">
        {fullPrices.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            請輸入商品代碼後按 LOAD 載入
          </div>
        ) : (
        <table className="w-full border-collapse text-xs text-center table-fixed tabular-nums select-none">
          <thead className="sticky top-0 z-40 bg-[#1C2331] text-slate-400 border-b border-slate-700 shadow-md">
            <tr>
              <th className="py-2 font-normal border-r border-slate-700 w-[10%] opacity-70">刪買</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[15%] text-red-500 bg-red-950/60">買進</th>
              <th className="py-2 font-normal border-r border-slate-700 w-[15%] text-red-300 bg-red-950/30">委買</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[20%] bg-slate-800 text-slate-200 shadow-lg">價格</th>
              <th className="py-2 font-normal border-r border-slate-700 w-[15%] text-emerald-300 bg-emerald-950/30">委賣</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[15%] text-emerald-500 bg-emerald-950/60">賣出</th>
              <th className="py-2 font-normal w-[10%] opacity-70">刪賣</th>
            </tr>
          </thead>
          <tbody className={`transition-all duration-500 ${isStale ? 'opacity-60' : ''}`}>
            {(() => {
              // 大單判定移到迴圈外，只算一次
              const tradeVol = qData.Volume ?? 0;
              const isBigTrade = tradeVol >= 50 || (currentPrice > 0 && tradeVol * currentPrice * 1000 >= 3000000);
              return fullPrices.map((p) => {
              const tick = getTickSize(p, targetSymbol);
              // 容差比對：容許最多 0.4 tick （防止浮點誤差不對齊）
              const isC = currentPrice > 0 && Math.abs(currentPrice - p) < tick * 0.4;
              const isCostLine = currentPosition && Math.abs(p - currentPosition.price) < (getTickSize(p, targetSymbol) * 0.5);
              const isLimitUp = limitUp > 0 && p === limitUp;
              const isLimitDown = limitDown > 0 && p === limitDown;
              
              const pKey = Math.round(p * 100);
              const bv = bidMap.get(pKey) ?? null;
              const av = askMap.get(pKey) ?? null;
              const diffBv = diffBidMap.get(pKey) ?? 0;
              const diffAv = diffAskMap.get(pKey) ?? 0;
              
              const cumBv = cumBidMap.get(pKey) || 0;
              const cumAv = cumAskMap.get(pKey) || 0;
              const bWidth = cumBv ? Math.min((cumBv / maxCumVolume) * 100, 100) : 0;
              const aWidth = cumAv ? Math.min((cumAv / maxCumVolume) * 100, 100) : 0;

              const myBuyQty = workingBuyMap.get(pKey) || 0;
              const mySellQty = workingSellMap.get(pKey) || 0;

              // 下單回饋閃爍
              const isBuyFb = orderFeedback && orderFeedback.price === p && orderFeedback.action === 'Buy';
              const isSellFb = orderFeedback && orderFeedback.price === p && orderFeedback.action === 'Sell';
              const fbBuyClass = isBuyFb 
                ? (orderFeedback!.status === 'success' ? 'bg-red-500/40' : orderFeedback!.status === 'error' ? 'bg-yellow-500/40' : 'bg-red-500/20 animate-pulse')
                : '';
              const fbSellClass = isSellFb 
                ? (orderFeedback!.status === 'success' ? 'bg-emerald-500/40' : orderFeedback!.status === 'error' ? 'bg-yellow-500/40' : 'bg-emerald-500/20 animate-pulse')
                : '';

              return (
                <tr key={p} data-price={pKey} className={`h-8 transition-none ${isC ? (flashDir === 'up' ? 'bg-red-500/30' : flashDir === 'down' ? 'bg-green-500/30' : 'bg-[#D4AF37]/10 border-y border-[#D4AF37]/50 box-border') : 'border-b border-slate-800/80'} ${isLimitUp ? 'border-t-2 border-t-red-600/60' : ''} ${isLimitDown ? 'border-b-2 border-b-emerald-600/60' : ''}`}>
                  {/* 刪買 */}
                  <td className="border-r border-slate-800 hover:bg-slate-700 cursor-pointer" 
                      onClick={() => myBuyQty > 0 && handleCancelOrder('Buy')}>
                    {myBuyQty > 0 && <span className="font-bold text-[10px] text-red-400 hover:text-white transition-colors">✕</span>}
                  </td>

                  {/* 買進 */}
                  <td className={`bg-red-950/40 text-red-500 font-bold cursor-pointer hover:bg-red-900/60 border-r border-slate-800 transition-colors ${fbBuyClass}`} 
                      onClick={() => handlePlaceOrder(p, 'Buy')}>
                      {myBuyQty > 0 && <span className="bg-red-600 text-white px-1.5 py-0.5 rounded text-[10px] shadow-sm">{myBuyQty}</span>}
                  </td>

                  {/* 委買量 (含 Δ買) */}
                  <td className="relative border-r border-slate-800 text-red-400 font-medium bg-red-950/20 overflow-hidden">
                      <div className="absolute inset-y-0.5 right-0 bg-gradient-to-l from-red-600/5 to-red-600/30 transition-all" style={{ width: `${bWidth}%` }}></div>
                      <div className="relative z-10 flex justify-between items-center px-2">
                        <span className={`text-[9px] font-bold ${diffBv > 0 ? 'text-red-400' : 'text-slate-500'}`}>{diffBv !== 0 ? (diffBv > 0 ? `+${diffBv}` : diffBv) : ''}</span>
                        <span>{bv || ''}</span>
                      </div>
                  </td>
                  
                  {/* 價格 (含最新單筆成交量) */}
                  <td className={`font-black border-r border-slate-800 text-[13px] overflow-hidden ${isC ? 'bg-[#D4AF37] text-black shadow-[inset_0_0_12px_rgba(212,175,55,0.3)]' : isLimitUp ? 'text-red-400 bg-red-950/30' : isLimitDown ? 'text-emerald-400 bg-emerald-950/30' : (p > refPrice ? 'text-red-500 bg-slate-900/40' : p < refPrice ? 'text-emerald-500 bg-slate-900/40' : 'text-slate-300 bg-slate-900/40')}`}>
                      <div className="flex items-center justify-center gap-1 relative w-full h-full text-center">
                          {isLimitUp && !isC && <div className="absolute top-0 right-0 text-[9px] leading-tight text-white bg-red-600 px-1 py-0.5 rounded-bl font-bold z-20 shadow-md transform">漲停</div>}
                          {isLimitDown && !isC && <div className="absolute bottom-0 right-0 text-[9px] leading-tight text-white bg-emerald-600 px-1 py-0.5 rounded-tl font-bold z-20 shadow-md transform">跌停</div>}
                          
                          {/* 成交明細 (TickType: 1=外盤/紅/右，2=內盤/綠/左) */}
                          {isC && tradeVol > 0 && (
                            qData.TickType === 2 ? (
                              <span className={`absolute left-1 text-[10px] font-bold text-emerald-50 bg-emerald-600/90 px-1 rounded-sm shadow-sm transition-all ${isBigTrade ? 'ring-2 ring-emerald-400 shadow-[0_0_10px_rgba(16,185,129,1)] animate-pulse scale-110 z-30' : ''}`}>{tradeVol}</span>
                            ) : (
                              <span className={`absolute right-1 text-[10px] font-bold text-red-50 bg-red-600/90 px-1 rounded-sm shadow-sm transition-all ${isBigTrade ? 'ring-2 ring-red-400 shadow-[0_0_10px_rgba(239,68,68,1)] animate-pulse scale-110 z-30' : ''}`}>{tradeVol}</span>
                            )
                          )}
                          
                          {isCostLine && <div className="absolute inset-0 border-y border-blue-500/50 bg-blue-500/10"></div>}
                          {isCostLine && <span className="text-[9px] px-1 bg-blue-600 text-white rounded-sm z-10 shadow-sm font-bold absolute left-6">COST</span>}
                          
                          <span className="z-10 tracking-wider inline-block min-w-[3rem] px-2">{formatPrice(p, targetSymbol)}</span>
                          
                          {p === highPrice && !isC && <span className="text-[9px] text-red-500 font-bold z-10 absolute right-1">H</span>}
                          {p === lowPrice && !isC && <span className="text-[9px] text-emerald-500 font-bold z-10 absolute right-1">L</span>}
                      </div>
                  </td>
                  
                  {/* 委賣量 (含 Δ賣) */}
                  <td className="relative border-r border-slate-800 text-emerald-400 font-medium bg-emerald-950/20 overflow-hidden">
                      <div className="absolute inset-y-0.5 left-0 bg-gradient-to-r from-emerald-600/5 to-emerald-600/30 transition-all" style={{ width: `${aWidth}%` }}></div>
                      <div className="relative z-10 flex justify-between items-center px-2">
                        <span>{av || ''}</span>
                        <span className={`text-[9px] font-bold ${diffAv > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>{diffAv !== 0 ? (diffAv > 0 ? `+${diffAv}` : diffAv) : ''}</span>
                      </div>
                  </td>

                  {/* 賣出 */}
                  <td className={`bg-emerald-950/40 text-emerald-500 font-bold cursor-pointer hover:bg-emerald-900/60 border-r border-slate-800 transition-colors ${fbSellClass}`}
                      onClick={() => handlePlaceOrder(p, 'Sell')}>
                      {mySellQty > 0 && <span className="bg-emerald-600 text-white px-1.5 py-0.5 rounded text-[10px] shadow-sm">{mySellQty}</span>}
                  </td>

                  {/* 刪賣 */}
                  <td className="hover:bg-slate-700 cursor-pointer"
                      onClick={() => mySellQty > 0 && handleCancelOrder('Sell')}>
                    {mySellQty > 0 && <span className="font-bold text-[10px] text-emerald-400 hover:text-white transition-colors">✕</span>}
                  </td>
                </tr>
              );
            });
            })()}
          </tbody>
        </table>
        )}
      </div>

      {/* Footer — 快捷操作列 */}
      <div className="p-3 border-t border-slate-800 bg-[#1c2331] flex justify-end items-center shadow-2xl gap-2 md:gap-4">
          <div className="flex items-center gap-1.5 mr-auto">
              <button onClick={handleManualSync} className={`px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-[10px] font-bold transition-all active:scale-95 shadow-md cursor-pointer ${isSyncing ? 'opacity-50' : ''}`}>SYNC</button>
          </div>
          <div className="flex items-center gap-1.5">
              <button onClick={() => handleCancelOrder('Buy')} className="px-2.5 py-1.5 bg-red-900/40 hover:bg-red-800/60 text-red-400 hover:text-red-300 rounded text-[10px] font-bold border border-red-800/50 transition-all active:scale-95 cursor-pointer">全刪買</button>
              <button onClick={() => {
                if (window.confirm('確定要執行平倉 (市價清空所有部位)?')) handleFlatten();
              }} className="px-3 py-1.5 bg-amber-900/40 hover:bg-amber-800/60 text-amber-400 hover:text-amber-300 rounded text-[10px] font-black border border-amber-700/50 transition-all active:scale-95 cursor-pointer">平倉</button>
              <button onClick={() => {
                if (window.confirm('確定要執行反向沖銷 (反手)?\n此操作將市價平倉後立即反向建倉。')) handleReverse();
              }} className="px-3 py-1.5 bg-purple-900/40 hover:bg-purple-800/60 text-purple-400 hover:text-purple-300 rounded text-[10px] font-black border border-purple-700/50 transition-all active:scale-95 cursor-pointer">反手</button>
              <button onClick={() => handleCancelOrder('Sell')} className="px-2.5 py-1.5 bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-400 hover:text-emerald-300 rounded text-[10px] font-bold border border-emerald-800/50 transition-all active:scale-95 cursor-pointer">全刪賣</button>
          </div>
      </div>
    </div>
  );
};

export default DOMPanel;
