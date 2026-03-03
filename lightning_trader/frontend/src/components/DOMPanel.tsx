import React, { useState, useEffect, useMemo } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { apiClient } from '../api/client';

const DOMPanel: React.FC = () => {
  const context = useTradingContext();
  const { 
    quote, bidAsk, targetSymbol, accountSummary, 
    accounts = [], activeAccount, selectAccount = () => {} 
  } = context;

  const [orderValue, setOrderValue] = useState(1);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  
  const qData: any = quote || {};
  const bData: any = bidAsk || {};
  const currentPrice = qData.Price || 0;
  const refPrice = qData.Reference || 68.0;
  const highPrice = qData.High || 0;
  const lowPrice = qData.Low || 0;
  const isSimulation = accountSummary.is_simulation ?? true;

  // --- 報價閃爍邏輯 ---
  const prevPriceRef = React.useRef<number>(currentPrice);
  const [flashDir, setFlashDir] = useState<'up' | 'down' | 'none'>('none');

  useEffect(() => {
      if (currentPrice > prevPriceRef.current) {
          setFlashDir('up');
          setTimeout(() => setFlashDir('none'), 200);
      } else if (currentPrice < prevPriceRef.current) {
          setFlashDir('down');
          setTimeout(() => setFlashDir('none'), 200);
      }
      prevPriceRef.current = currentPrice;
  }, [currentPrice]);

  // --- 終極部位匹配 (模糊比對，只要包含數字 ID 就加總) ---
  const currentPosition = useMemo(() => {
    const positions = accountSummary.positions || [];
    if (!targetSymbol || positions.length === 0) return null;
    
    // 取得當前標的的純數字代碼 (如 5309)
    const targetCode = targetSymbol.trim().toUpperCase().replace(/\D/g, ''); 
    
    const allMatches = positions.filter((p: any) => {
        if (!p.symbol) return false;
        const pSymbol = String(p.symbol).trim().toUpperCase();
        // 如果 symbol 完全相同，或是 symbol 包含 targetCode (處理 TSE/5309 等格式)
        return pSymbol === targetSymbol.toUpperCase() || pSymbol.includes(targetCode);
    });

    if (allMatches.length === 0) return null;
    
    const totalQty = allMatches.reduce((sum: number, p: any) => sum + p.qty, 0);
    const avgPrice = allMatches.reduce((sum: number, p: any) => sum + (p.price * p.qty), 0) / (totalQty || 1);
    const totalBackendPnl = allMatches.reduce((sum: number, p: any) => sum + (p.pnl || 0), 0);
    
    return { 
        ...allMatches[0], 
        qty: totalQty, 
        price: avgPrice, 
        backendPnl: totalBackendPnl,
        matchCount: allMatches.length
    };
  }, [accountSummary.positions, targetSymbol]);

  const netQty = currentPosition ? (currentPosition.direction === 'Buy' ? currentPosition.qty : -currentPosition.qty) : 0;
  
  // --- 損益重算 ---
  const realtimePnL = useMemo(() => {
    if (netQty === 0 || !currentPosition) return 0;
    const cp = currentPrice || refPrice;
    if (cp > 0 && currentPosition.price > 0) {
        const sym = targetSymbol || "";
        let multiplier = (sym.startsWith('MXF') || sym.includes('小台')) ? 50 : (sym.startsWith('TXF') || sym.includes('大台')) ? 200 : 1000;
        const localPnl = Math.round((cp - currentPosition.price) * netQty * multiplier);
        if (localPnl !== 0) return localPnl;
    }
    return currentPosition.backendPnl || 0;
  }, [currentPrice, refPrice, currentPosition, netQty, targetSymbol]);

  const getTickSize = (p: number) => {
    const sym = (targetSymbol || "").toUpperCase();
    // 期貨合約：台指期(TXF/MXF)跳動單位固定 1 點
    if (sym.startsWith('TXF') || sym.startsWith('MXF') || sym.startsWith('TX') || sym.startsWith('MX')) return 1;
    // 股票跳價級距 (台灣證交所規定)
    if (p < 10) return 0.01; if (p < 50) return 0.05; if (p < 100) return 0.1; if (p < 500) return 0.5; if (p < 1000) return 1.0; return 5.0;
  };

  const fullPrices = useMemo(() => {
    const base = currentPrice || refPrice || 68.0;
    
    // 往下算 25 檔，動態調整 tick size
    let pDown = base;
    const lowerPrices = [];
    for (let i = 0; i < 25; i++) {
        pDown = Math.round((pDown - getTickSize(pDown - 0.0001)) * 100) / 100;
        lowerPrices.push(pDown);
    }
    
    // 往上算 25 檔，動態調整 tick size
    let pUp = base;
    const upperPrices = [];
    for (let i = 0; i < 25; i++) {
        pUp = Math.round((pUp + getTickSize(pUp)) * 100) / 100;
        upperPrices.push(pUp);
    }
    
    return [...upperPrices.reverse(), base, ...lowerPrices];
  }, [currentPrice, refPrice]);

  // --- 建立五檔 BidAsk 查找表 (以 round key 避免浮點精度問題) ---
  const bidMap = useMemo(() => {
    const m = new Map<number, number>();
    const prices = bData.BidPrice || [];
    const vols = bData.BidVolume || [];
    for (let i = 0; i < prices.length; i++) {
      const key = Math.round(prices[i] * 100);
      m.set(key, vols[i] || 0);
    }
    return m;
  }, [bData]);

  const askMap = useMemo(() => {
    const m = new Map<number, number>();
    const prices = bData.AskPrice || [];
    const vols = bData.AskVolume || [];
    for (let i = 0; i < prices.length; i++) {
      const key = Math.round(prices[i] * 100);
      m.set(key, vols[i] || 0);
    }
    return m;
  }, [bData]);

  const maxVolume = useMemo(() => {
      const bidVols = bData.BidVolume || [];
      const askVols = bData.AskVolume || [];
      return Math.max(...bidVols, ...askVols, 1);
  }, [bData]);

  const handleManualSync = async () => {
      setIsSyncing(true);
      try { if (activeAccount) await selectAccount(activeAccount); } catch(e) {}
      finally { setTimeout(() => setIsSyncing(false), 1000); }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-slate-800 bg-[#101623] text-slate-100 relative overflow-hidden shadow-2xl">
      
      {/* 診斷面板 */}
      {isSettingsOpen && (
        <div className="absolute inset-0 z-[100] bg-[#1c2331] p-6 overflow-y-auto">
            <div className="flex justify-between items-center mb-4 border-b border-slate-700 pb-2">
                <h3 className="font-bold text-red-500 underline text-lg">TRUTH DIAGNOSTIC</h3>
                <button onClick={() => setIsSettingsOpen(false)} className="text-2xl font-black">✕</button>
            </div>
            <div className="bg-black/40 p-3 rounded mb-4 border border-slate-700">
                <p className="text-xs text-yellow-500 font-bold">Detected Pos Matches: {currentPosition?.matchCount || 0}</p>
                <p className="text-xs text-blue-400 font-bold">WS Message Count: {accountSummary.msg_count}</p>
            </div>
            <pre className="text-[10px] bg-black p-4 rounded text-emerald-400 overflow-x-auto border border-emerald-900/30">
                {JSON.stringify({
                    target: targetSymbol,
                    currentPosition,
                    ws_pool: accountSummary.positions
                }, null, 2)}
            </pre>
        </div>
      )}

      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800 bg-[#1c2331] flex items-center justify-between shrink-0 shadow-lg">
        <div className="flex items-center gap-3">
            <div className="flex flex-col">
                <span className="text-[8px] opacity-50 uppercase font-bold mb-0.5">Account</span>
                <select 
                    value={activeAccount || ''} 
                    onChange={(e) => selectAccount(e.target.value)}
                    className="bg-[#101623] border border-slate-700 rounded text-[11px] font-bold p-1 text-[#D4AF37] outline-none"
                >
                    {accounts.map((acc: any) => (
                        <option key={acc.account_id} value={`${acc.broker_id}-${acc.account_id}`}>{acc.account_id}</option>
                    ))}
                </select>
            </div>

            <div className={`flex flex-col items-center px-3 py-1 rounded border ${netQty > 0 ? 'bg-red-900/20 border-red-800/50' : netQty < 0 ? 'bg-blue-900/20 border-blue-800/50' : 'bg-slate-800 border-slate-700'}`}>
                <span className="text-[8px] opacity-50 uppercase font-bold">Position</span>
                <span className={`text-sm font-black leading-none ${netQty > 0 ? 'text-red-400 shadow-[0_0_10px_#ef444433]' : netQty < 0 ? 'text-blue-400 shadow-[0_0_10px_#3b82f633]' : 'text-slate-500'}`}>
                    {netQty > 0 ? 'LONG' : netQty < 0 ? 'SHORT' : 'FLAT'} {Math.abs(netQty)}
                </span>
            </div>

            <div className={`flex flex-col items-center px-3 py-1 rounded border ${realtimePnL >= 0 ? 'bg-emerald-900/20 border-emerald-800/50' : 'bg-red-900/20 border-red-800/50'}`}>
                <span className="text-[8px] opacity-50 uppercase font-bold text-center">Reference PnL</span>
                <span className={`text-sm font-mono font-black leading-none ${realtimePnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {realtimePnL.toLocaleString()}
                </span>
            </div>
        </div>
        
        <div className="flex items-center gap-2">
            <div className={`px-2 py-1 rounded-md border ${isSimulation ? 'border-yellow-600/50 bg-yellow-900/20' : 'border-emerald-600/50 bg-emerald-900/20'}`}>
                <p className={`text-[10px] font-black ${isSimulation ? 'text-yellow-500' : 'text-emerald-500'}`}>{isSimulation ? 'SIM' : 'LIVE'}</p>
            </div>
            <button onClick={() => setIsSettingsOpen(true)} className="px-3 py-1 bg-red-600 text-white rounded text-[10px] font-bold animate-pulse shadow-lg">DEBUG</button>
        </div>
      </div>

      {/* Main Table Area */}
      <div className="flex-1 overflow-auto bg-black/10 custom-scrollbar">
        <table className="w-full border-collapse text-xs text-center table-fixed tabular-nums select-none">
          <thead className="sticky top-0 z-10 bg-slate-900 text-slate-400 border-b border-slate-700 shadow-md">
            <tr>
              <th className="py-2 font-normal border-r border-slate-700 w-[10%] opacity-70">刪買</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[15%] text-red-500 bg-red-950/60 shadow-[inset_0_0_10px_rgba(239,68,68,0.1)]">買進</th>
              <th className="py-2 font-normal border-r border-slate-700 w-[15%] text-red-300 bg-red-950/30">委買</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[20%] bg-slate-800 text-slate-200 shadow-lg z-20">價格</th>
              <th className="py-2 font-normal border-r border-slate-700 w-[15%] text-emerald-300 bg-emerald-950/30">委賣</th>
              <th className="py-2 font-bold border-r border-slate-700 w-[15%] text-emerald-500 bg-emerald-950/60 shadow-[inset_0_0_10px_rgba(16,185,129,0.1)]">賣出</th>
              <th className="py-2 font-normal w-[10%] opacity-70">刪賣</th>
            </tr>
          </thead>
          <tbody>
            {fullPrices.map((p) => {
              const isC = currentPrice === p;
              const isCostLine = currentPosition && Math.abs(p - currentPosition.price) < (getTickSize(p) * 0.5);
              
              // 使用 Map 查找 (以 rounded 整數 key 避免浮點精度問題)
              const pKey = Math.round(p * 100);
              const bv = bidMap.get(pKey) ?? null;
              const av = askMap.get(pKey) ?? null;
              
              const bWidth = bv ? Math.min((bv / maxVolume) * 100, 100) : 0;
              const aWidth = av ? Math.min((av / maxVolume) * 100, 100) : 0;

              // TODO: Integrate actual working orders later
              const mockWorkingBuyQty = 0; 
              const mockWorkingSellQty = 0;

              return (
                <tr key={p} className={`h-8 border-b border-slate-800/80 transition-none ${isC ? (flashDir === 'up' ? 'bg-red-500/30' : flashDir === 'down' ? 'bg-green-500/30' : 'bg-yellow-500/10') : ''}`}>
                  {/* Cancel Buy */}
                  <td className="border-r border-slate-800 hover:bg-slate-700 cursor-pointer text-slate-500 flex items-center justify-center">
                    {mockWorkingBuyQty > 0 && <span className="font-bold text-[10px] hover:text-white transition-colors">✕</span>}
                  </td>

                  {/* Place Buy Order */}
                  <td className="bg-red-950/40 text-red-500 font-bold cursor-pointer hover:bg-red-900/60 border-r border-slate-800 transition-colors" 
                      onClick={() => apiClient.post('/place_order', { symbol: targetSymbol, price: p, action: 'Buy', qty: orderValue, order_type: 'ROD' })}>
                      {mockWorkingBuyQty > 0 && <span className="bg-red-600 text-white px-2 py-0.5 rounded shadow-sm shadow-red-900/50">{mockWorkingBuyQty}</span>}
                  </td>

                  {/* Bid Volume */}
                  <td className="relative border-r border-slate-800 text-red-400 font-medium bg-red-950/20">
                      <div className="absolute inset-y-0.5 right-0 bg-red-500/15 transition-all" style={{ width: `${bWidth}%` }}></div>
                      <span className="relative z-10">{bv || ''}</span>
                  </td>
                  
                  {/* Price */}
                  <td className={`font-black border-r border-slate-800 text-[13px] ${isC ? 'bg-[#D4AF37] text-black shadow-lg shadow-[#D4AF37]/20 rounded-sm z-20 relative scale-[1.02]' : (p > refPrice ? 'text-red-500 bg-slate-900/40' : p < refPrice ? 'text-emerald-500 bg-slate-900/40' : 'text-slate-300 bg-slate-900/40')}`}>
                      <div className="flex items-center justify-center gap-1.5 relative w-full h-full">
                          {isCostLine && <div className="absolute inset-0 border-y border-blue-500/50 bg-blue-500/10"></div>}
                          {isCostLine && <span className="text-[9px] px-1 bg-blue-600 text-white rounded-sm z-10 shadow-sm shadow-blue-900/50 font-bold">COST</span>}
                          <span className="z-10 tracking-wider">{p.toFixed(2)}</span>
                          {p === highPrice && <span className="text-[9px] text-red-500 font-bold z-10 absolute right-1 top-0.5">H</span>}
                          {p === lowPrice && <span className="text-[9px] text-emerald-500 font-bold z-10 absolute right-1 bottom-0.5">L</span>}
                      </div>
                  </td>
                  
                  {/* Ask Volume */}
                  <td className="relative border-r border-slate-800 text-emerald-400 font-medium bg-emerald-950/20">
                      <div className="absolute inset-y-0.5 left-0 bg-emerald-500/15 transition-all" style={{ width: `${aWidth}%` }}></div>
                      <span className="relative z-10">{av || ''}</span>
                  </td>

                  {/* Place Sell Order */}
                  <td className="bg-emerald-950/40 text-emerald-500 font-bold cursor-pointer hover:bg-emerald-900/60 border-r border-slate-800 transition-colors"
                      onClick={() => apiClient.post('/place_order', { symbol: targetSymbol, price: p, action: 'Sell', qty: orderValue, order_type: 'ROD' })}>
                      {mockWorkingSellQty > 0 && <span className="bg-emerald-600 text-white px-2 py-0.5 rounded shadow-sm shadow-emerald-900/50">{mockWorkingSellQty}</span>}
                  </td>

                  {/* Cancel Sell */}
                  <td className="hover:bg-slate-700 cursor-pointer text-slate-500 flex items-center justify-center">
                    {mockWorkingSellQty > 0 && <span className="font-bold text-[10px] hover:text-white transition-colors">✕</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-slate-800 bg-[#1c2331] flex justify-between items-center shadow-2xl">
          <div className="flex items-center gap-3">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Order Quantity</span>
              <div className="flex items-center bg-[#101623] rounded-lg border border-slate-700 p-1">
                  <button onClick={() => setOrderValue(Math.max(1, orderValue-1))} className="w-8 h-8 text-slate-400 hover:text-white">-</button>
                  <input type="number" value={orderValue} onChange={(e) => setOrderValue(Number(e.target.value))} className="w-12 bg-transparent text-center text-[#D4AF37] text-lg font-black focus:outline-none" />
                  <button onClick={() => setOrderValue(orderValue+1)} className="w-8 h-8 text-slate-400 hover:text-white">+</button>
              </div>
          </div>
          <button onClick={handleManualSync} className={`px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-black text-xs transition-all active:scale-95 shadow-lg shadow-blue-900/40 ${isSyncing ? 'animate-spin opacity-50' : ''}`}>
              FORCE SYNC 🔄
          </button>
      </div>
    </div>
  );
};

export default DOMPanel;
