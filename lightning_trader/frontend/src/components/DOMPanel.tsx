import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { apiClient } from '../api/client';

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

const DOMPanel: React.FC = () => {
  const context = useTradingContext();
  const { 
    quote, bidAsk, targetSymbol, accountSummary, 
    accounts = [], activeAccount, selectAccount = () => {} 
  } = context;

  const [orderValue, setOrderValue] = useState(1);
  const [isSyncing, setIsSyncing] = useState(false);
  
  // 下單回饋狀態
  const [orderFeedback, setOrderFeedback] = useState<{price: number; action: string; status: 'pending'|'success'|'error'} | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // 掛單查詢
  const [workingOrders, setWorkingOrders] = useState<WorkingOrder[]>([]);

  // 自動捲動到當前價
  const tableRef = useRef<HTMLDivElement>(null);
  const hasScrolled = useRef(false);
  
  const qData: any = quote || {};
  const bData: any = bidAsk || {};
  const currentPrice = qData.Price || 0;
  const refPrice = qData.Reference || 0;
  const limitUp = qData.LimitUp || 0;
  const limitDown = qData.LimitDown || 0;
  const highPrice = qData.High || 0;
  const lowPrice = qData.Low || 0;
  const isSimulation = accountSummary.is_simulation ?? true;

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

  // --- 報價閃爍邏輯 ---
  const prevPriceRef = useRef<number>(currentPrice);
  const [flashDir, setFlashDir] = useState<'up' | 'down' | 'none'>('none');

  useEffect(() => {
    if (currentPrice > 0 && prevPriceRef.current > 0) {
      if (currentPrice > prevPriceRef.current) {
        setFlashDir('up');
        setTimeout(() => setFlashDir('none'), 200);
      } else if (currentPrice < prevPriceRef.current) {
        setFlashDir('down');
        setTimeout(() => setFlashDir('none'), 200);
      }
    }
    prevPriceRef.current = currentPrice;
  }, [currentPrice]);

  // --- 部位匹配 ---
  const currentPosition = useMemo(() => {
    const positions = accountSummary.positions || [];
    if (!targetSymbol || positions.length === 0) return null;
    const targetCode = targetSymbol.trim().toUpperCase().replace(/\D/g, ''); 
    const allMatches = positions.filter((p: any) => {
      if (!p.symbol) return false;
      const pSymbol = String(p.symbol).trim().toUpperCase();
      return pSymbol === targetSymbol.toUpperCase() || pSymbol.includes(targetCode);
    });
    if (allMatches.length === 0) return null;
    const totalQty = allMatches.reduce((sum: number, p: any) => sum + p.qty, 0);
    const avgPrice = allMatches.reduce((sum: number, p: any) => sum + (p.price * p.qty), 0) / (totalQty || 1);
    const totalBackendPnl = allMatches.reduce((sum: number, p: any) => sum + (p.pnl || 0), 0);
    return { ...allMatches[0], qty: totalQty, price: avgPrice, backendPnl: totalBackendPnl };
  }, [accountSummary.positions, targetSymbol]);

  const netQty = currentPosition ? (currentPosition.direction === 'Buy' ? currentPosition.qty : -currentPosition.qty) : 0;
  
  // --- 損益重算 ---
  const realtimePnL = useMemo(() => {
    if (netQty === 0 || !currentPosition) return 0;
    const cp = currentPrice || refPrice;
    if (cp > 0 && currentPosition.price > 0) {
      const sym = targetSymbol || "";
      const multiplier = (sym.startsWith('MXF') || sym.includes('小台')) ? 50 : (sym.startsWith('TXF') || sym.includes('大台')) ? 200 : 1000;
      const localPnl = Math.round((cp - currentPosition.price) * netQty * multiplier);
      if (localPnl !== 0) return localPnl;
    }
    return currentPosition.backendPnl || 0;
  }, [currentPrice, refPrice, currentPosition, netQty, targetSymbol]);

  // --- ★ 核心：漲停→跌停完整價格表 ---
  const fullPrices = useMemo(() => {
    // 需要至少有 reference price 才能算
    const base = currentPrice || refPrice;
    if (base <= 0) return [];

    const up = limitUp > 0 ? limitUp : round2(base * 1.1);
    const down = limitDown > 0 ? limitDown : round2(base * 0.9);
    const sym = targetSymbol || '';

    const prices: number[] = [];
    let p = up;
    // 從漲停往下逐 tick 算到跌停（最多 500 檔防無限迴圈）
    while (p >= down && prices.length < 500) {
      prices.push(p);
      const tick = getTickSize(p, sym);
      p = round2(p - tick);
    }
    return prices;
  }, [currentPrice, refPrice, limitUp, limitDown, targetSymbol]);

  // --- 自動捲動到當前價（首次載入） ---
  useEffect(() => {
    if (currentPrice > 0 && fullPrices.length > 0 && !hasScrolled.current) {
      hasScrolled.current = true;
      setTimeout(() => {
        const row = document.querySelector(`[data-price="${currentPrice}"]`);
        if (row) {
          row.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      }, 100);
    }
  }, [currentPrice, fullPrices]);

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

  const maxVolume = useMemo(() => {
    const bidVols = bData.BidVolume || [];
    const askVols = bData.AskVolume || [];
    return Math.max(...bidVols, ...askVols, 1);
  }, [bData]);

  // --- 下單（含回饋） ---
  const handlePlaceOrder = useCallback(async (price: number, action: 'Buy' | 'Sell') => {
    if (orderFeedback && orderFeedback.status === 'pending') return;
    
    setOrderFeedback({ price, action, status: 'pending' });
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);

    try {
      await apiClient.post('/place_order', { 
        symbol: targetSymbol, price, action, qty: orderValue, order_type: 'ROD' 
      });
      setOrderFeedback({ price, action, status: 'success' });
    } catch {
      setOrderFeedback({ price, action, status: 'error' });
    }
    feedbackTimerRef.current = setTimeout(() => setOrderFeedback(null), 800);
  }, [targetSymbol, orderValue, orderFeedback]);

  // --- 刪單 ---
  const handleCancelAtPrice = useCallback(async (action: 'Buy' | 'Sell') => {
    try { await apiClient.post('/cancel_all', { symbol: targetSymbol, action }); } catch { /* */ }
  }, [targetSymbol]);

  // --- Footer 快捷操作 ---
  const handleCancelAllBuy = useCallback(async () => {
    try { await apiClient.post('/cancel_all', { symbol: targetSymbol, action: 'Buy' }); } catch { /* */ }
  }, [targetSymbol]);

  const handleCancelAllSell = useCallback(async () => {
    try { await apiClient.post('/cancel_all', { symbol: targetSymbol, action: 'Sell' }); } catch { /* */ }
  }, [targetSymbol]);

  const handleFlatten = useCallback(async () => {
    try { await apiClient.post('/flatten', { symbol: targetSymbol }); } catch { /* */ }
  }, [targetSymbol]);

  const handleReverse = useCallback(async () => {
    try { await apiClient.post('/reverse', { symbol: targetSymbol }); } catch { /* */ }
  }, [targetSymbol]);

  const handleManualSync = async () => {
    setIsSyncing(true);
    try { if (activeAccount) await selectAccount(activeAccount); } catch { /* */ }
    finally { setTimeout(() => setIsSyncing(false), 1000); }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-slate-800 bg-[#101623] text-slate-100 relative overflow-hidden shadow-2xl">
      
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800 bg-[#1c2331] flex items-center justify-between shrink-0 shadow-lg">
        <div className="flex items-center gap-3">
            <div className="flex flex-col">
                <span className="text-[8px] opacity-50 uppercase font-bold mb-0.5">Account</span>
                <select 
                    value={activeAccount || ''} 
                    onChange={(e) => selectAccount(e.target.value)}
                    className="bg-[#101623] border border-slate-700 rounded text-[11px] font-bold p-1 text-[#D4AF37] outline-none cursor-pointer"
                >
                    {accounts.map((acc: any) => (
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
            <div className={`px-2 py-1 rounded-md border ${isSimulation ? 'border-yellow-600/50 bg-yellow-900/20' : 'border-emerald-600/50 bg-emerald-900/20'}`}>
                <p className={`text-[10px] font-black ${isSimulation ? 'text-yellow-500' : 'text-emerald-500'}`}>{isSimulation ? 'SIM' : 'LIVE'}</p>
            </div>
            {fullPrices.length > 0 && (
                <div className="text-[9px] text-slate-500 font-mono">
                    {formatPrice(fullPrices[0], targetSymbol)}~{formatPrice(fullPrices[fullPrices.length - 1], targetSymbol)}
                </div>
            )}
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
          <thead className="sticky top-0 z-10 bg-slate-900 text-slate-400 border-b border-slate-700 shadow-md">
            <tr>
              <th className="py-2 font-normal border-r border-slate-700 w-[10%] opacity-70">刪買</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[15%] text-red-500 bg-red-950/60">買進</th>
              <th className="py-2 font-normal border-r border-slate-700 w-[15%] text-red-300 bg-red-950/30">委買</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[20%] bg-slate-800 text-slate-200 shadow-lg z-20">價格</th>
              <th className="py-2 font-normal border-r border-slate-700 w-[15%] text-emerald-300 bg-emerald-950/30">委賣</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[15%] text-emerald-500 bg-emerald-950/60">賣出</th>
              <th className="py-2 font-normal w-[10%] opacity-70">刪賣</th>
            </tr>
          </thead>
          <tbody>
            {fullPrices.map((p) => {
              const isC = currentPrice > 0 && currentPrice === p;
              const isCostLine = currentPosition && Math.abs(p - currentPosition.price) < (getTickSize(p, targetSymbol) * 0.5);
              const isLimitUp = limitUp > 0 && p === limitUp;
              const isLimitDown = limitDown > 0 && p === limitDown;
              
              const pKey = Math.round(p * 100);
              const bv = bidMap.get(pKey) ?? null;
              const av = askMap.get(pKey) ?? null;
              
              const bWidth = bv ? Math.min((bv / maxVolume) * 100, 100) : 0;
              const aWidth = av ? Math.min((av / maxVolume) * 100, 100) : 0;

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
                <tr key={p} data-price={p} className={`h-8 border-b border-slate-800/80 transition-none ${isC ? (flashDir === 'up' ? 'bg-red-500/30' : flashDir === 'down' ? 'bg-green-500/30' : 'bg-yellow-500/10') : ''} ${isLimitUp ? 'border-t-2 border-t-red-600/60' : ''} ${isLimitDown ? 'border-b-2 border-b-emerald-600/60' : ''}`}>
                  {/* 刪買 */}
                  <td className="border-r border-slate-800 hover:bg-slate-700 cursor-pointer" 
                      onClick={() => myBuyQty > 0 && handleCancelAtPrice('Buy')}>
                    {myBuyQty > 0 && <span className="font-bold text-[10px] text-red-400 hover:text-white transition-colors">✕</span>}
                  </td>

                  {/* 買進 */}
                  <td className={`bg-red-950/40 text-red-500 font-bold cursor-pointer hover:bg-red-900/60 border-r border-slate-800 transition-colors ${fbBuyClass}`} 
                      onClick={() => handlePlaceOrder(p, 'Buy')}>
                      {myBuyQty > 0 && <span className="bg-red-600 text-white px-1.5 py-0.5 rounded text-[10px] shadow-sm">{myBuyQty}</span>}
                  </td>

                  {/* 委買量 */}
                  <td className="relative border-r border-slate-800 text-red-400 font-medium bg-red-950/20">
                      <div className="absolute inset-y-0.5 right-0 bg-red-500/15 transition-all" style={{ width: `${bWidth}%` }}></div>
                      <span className="relative z-10">{bv || ''}</span>
                  </td>
                  
                  {/* 價格 */}
                  <td className={`font-black border-r border-slate-800 text-[13px] ${isC ? 'bg-[#D4AF37] text-black shadow-lg shadow-[#D4AF37]/20 rounded-sm z-20 relative scale-[1.02]' : isLimitUp ? 'text-red-400 bg-red-950/30' : isLimitDown ? 'text-emerald-400 bg-emerald-950/30' : (p > refPrice ? 'text-red-500 bg-slate-900/40' : p < refPrice ? 'text-emerald-500 bg-slate-900/40' : 'text-slate-300 bg-slate-900/40')}`}>
                      <div className="flex items-center justify-center gap-1 relative w-full h-full">
                          {isCostLine && <div className="absolute inset-0 border-y border-blue-500/50 bg-blue-500/10"></div>}
                          {isCostLine && <span className="text-[9px] px-1 bg-blue-600 text-white rounded-sm z-10 shadow-sm font-bold">COST</span>}
                          {isLimitUp && <span className="text-[8px] text-red-500 font-bold z-10">▲</span>}
                          {isLimitDown && <span className="text-[8px] text-emerald-500 font-bold z-10">▼</span>}
                          <span className="z-10 tracking-wider">{formatPrice(p, targetSymbol)}</span>
                          {p === highPrice && <span className="text-[9px] text-red-500 font-bold z-10 absolute right-1 top-0.5">H</span>}
                          {p === lowPrice && <span className="text-[9px] text-emerald-500 font-bold z-10 absolute right-1 bottom-0.5">L</span>}
                      </div>
                  </td>
                  
                  {/* 委賣量 */}
                  <td className="relative border-r border-slate-800 text-emerald-400 font-medium bg-emerald-950/20">
                      <div className="absolute inset-y-0.5 left-0 bg-emerald-500/15 transition-all" style={{ width: `${aWidth}%` }}></div>
                      <span className="relative z-10">{av || ''}</span>
                  </td>

                  {/* 賣出 */}
                  <td className={`bg-emerald-950/40 text-emerald-500 font-bold cursor-pointer hover:bg-emerald-900/60 border-r border-slate-800 transition-colors ${fbSellClass}`}
                      onClick={() => handlePlaceOrder(p, 'Sell')}>
                      {mySellQty > 0 && <span className="bg-emerald-600 text-white px-1.5 py-0.5 rounded text-[10px] shadow-sm">{mySellQty}</span>}
                  </td>

                  {/* 刪賣 */}
                  <td className="hover:bg-slate-700 cursor-pointer"
                      onClick={() => mySellQty > 0 && handleCancelAtPrice('Sell')}>
                    {mySellQty > 0 && <span className="font-bold text-[10px] text-emerald-400 hover:text-white transition-colors">✕</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </div>

      {/* Footer — 快捷操作列 */}
      <div className="p-3 border-t border-slate-800 bg-[#1c2331] flex justify-between items-center shadow-2xl gap-2">
          <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">QTY</span>
              <div className="flex items-center bg-[#101623] rounded-lg border border-slate-700 p-0.5">
                  <button onClick={() => setOrderValue(Math.max(1, orderValue-1))} className="w-7 h-7 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors cursor-pointer">-</button>
                  <input type="number" value={orderValue} onChange={(e) => setOrderValue(Math.max(1, Number(e.target.value)))} className="w-10 bg-transparent text-center text-[#D4AF37] text-sm font-black focus:outline-none" />
                  <button onClick={() => setOrderValue(orderValue+1)} className="w-7 h-7 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors cursor-pointer">+</button>
              </div>
          </div>

          <div className="flex items-center gap-1.5">
              <button onClick={handleCancelAllBuy} className="px-2.5 py-1.5 bg-red-900/40 hover:bg-red-800/60 text-red-400 hover:text-red-300 rounded text-[10px] font-bold border border-red-800/50 transition-all active:scale-95 cursor-pointer">全刪買</button>
              <button onClick={handleFlatten} className="px-3 py-1.5 bg-amber-900/40 hover:bg-amber-800/60 text-amber-400 hover:text-amber-300 rounded text-[10px] font-black border border-amber-700/50 transition-all active:scale-95 cursor-pointer">平倉</button>
              <button onClick={handleReverse} className="px-3 py-1.5 bg-purple-900/40 hover:bg-purple-800/60 text-purple-400 hover:text-purple-300 rounded text-[10px] font-black border border-purple-700/50 transition-all active:scale-95 cursor-pointer">反手</button>
              <button onClick={handleCancelAllSell} className="px-2.5 py-1.5 bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-400 hover:text-emerald-300 rounded text-[10px] font-bold border border-emerald-800/50 transition-all active:scale-95 cursor-pointer">全刪賣</button>
          </div>

          <button onClick={handleManualSync} className={`px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-[10px] font-bold transition-all active:scale-95 shadow-md cursor-pointer ${isSyncing ? 'opacity-50' : ''}`}>SYNC</button>
      </div>
    </div>
  );
};

export default DOMPanel;
