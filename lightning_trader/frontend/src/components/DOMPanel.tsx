import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { apiClient } from '../api/client';

const DOMPanel: React.FC = () => {
  const { quote, bidAsk, targetSymbol, accountSummary } = useTradingContext();
  const [orderMode, setOrderMode] = useState<'Qty' | 'Amount'>('Qty');
  const [orderValue, setOrderValue] = useState(1);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [isCombatMode, setIsCombatMode] = useState(true);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const currentPriceRef = useRef<HTMLTableRowElement>(null);

  // 取得當前商品的部位資訊
  const currentPosition = accountSummary?.positions?.find(p => p.symbol === targetSymbol);
  const netQty = currentPosition ? (currentPosition.direction === 'Buy' ? currentPosition.qty : -currentPosition.qty) : 0;
  const avgPrice = currentPosition?.price || 0;

  const centerToCurrentPrice = () => {
    if (currentPriceRef.current) {
      currentPriceRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        centerToCurrentPrice();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        handleCancelAll('Buy');
        handleCancelAll('Sell');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [targetSymbol]);

  const calculateFinalQty = (price: number) => {
    if (orderMode === 'Qty') return orderValue;
    // 萬模式： orderValue 萬。1張=1000股, 總額=price*1000。
    // 張數 = floor((orderValue * 10000) / (price * 1000)) = floor((orderValue * 10) / price)
    const q = Math.floor((orderValue * 10) / price);
    return Math.max(0, q);
  };

  const handlePlaceOrder = async (action: 'Buy' | 'Sell', price: number) => {
    if (placingOrder) return;
    if (price <= 0) return;

    const finalQty = calculateFinalQty(price);
    if (finalQty < 1) {
      alert("換算張數不足 1 張，請提高金額或改用零股交易。");
      return;
    }

    if (!isCombatMode) {
      const confirm = window.confirm(`確認下單: ${action} ${finalQty}張 @ ${price}?`);
      if (!confirm) return;
    }

    setPlacingOrder(true);
    try {
      await apiClient.post('/place_order', {
        symbol: targetSymbol,
        price,
        action,
        qty: finalQty,
        order_type: "ROD"
      });
    } catch (err) {
      console.error("Order failed", err);
    } finally {
      setPlacingOrder(false);
    }
  };

  const handleMarketOrder = async (action: 'Buy' | 'Sell') => {
    if (placingOrder) return;

    const estPrice = currentPrice > 0 ? currentPrice : refPrice;
    if (estPrice <= 0) return;

    const finalQty = calculateFinalQty(estPrice);
    if (finalQty < 1) {
      alert("換算張數不足 1 張，請提高金額或改用零股交易。");
      return;
    }

    if (!isCombatMode) {
      const confirm = window.confirm(`確認市價下單: ${action} ${finalQty}張?`);
      if (!confirm) return;
    }

    setPlacingOrder(true);
    try {
      await apiClient.post('/place_order', {
        symbol: targetSymbol,
        price: 0,
        action,
        qty: finalQty,
        order_type: "IOC"
      });
    } catch (err) {
      console.error("Market order failed", err);
    } finally {
      setPlacingOrder(false);
    }
  };

  const handleCancelAll = async (action: 'Buy' | 'Sell') => {
    try {
      await apiClient.post('/cancel_all', {
        symbol: targetSymbol,
        action
      });
    } catch (err) {
      console.warn("Cancel all failed", err);
    }
  };

  const currentPrice = quote?.Price || 0;
  const refPrice = quote?.Reference || 0;
  const highPrice = quote?.High || 0;
  const lowPrice = quote?.Low || 0;

  const maxVolume = useMemo(() => Math.max(
    ...(bidAsk?.BidVolume || [0]),
    ...(bidAsk?.AskVolume || [0]),
    1
  ), [bidAsk]);

  const totalBidVol = useMemo(() => (bidAsk?.BidVolume || []).reduce((a, b) => a + b, 0), [bidAsk]);
  const totalAskVol = useMemo(() => (bidAsk?.AskVolume || []).reduce((a, b) => a + b, 0), [bidAsk]);

  const getPriceColor = (p: number) => {
    if (!refPrice || p === refPrice) return 'text-white';
    return p > refPrice ? 'text-red-500' : 'text-green-500';
  };

  // 格式化價格：整數部分大，小數部分小
  const renderPrice = (p: number) => {
    const s = p.toFixed(p < 1000 ? 2 : 1);
    const parts = s.split('.');
    return (
      <span className="font-bold">
        {parts[0]}<span className="text-[10px] opacity-80">.{parts[1]}</span>
      </span>
    );
  };

  // 依據參考價生成台股真實 Tick Size 陣列
  const generateFullPriceRange = (refP: number, limitUp: number, limitDown: number): number[] => {
    if (!refP || !limitUp || !limitDown) return [];

    // 台股現貨 Tick Size Rule
    const getTickSize = (p: number) => {
      if (p < 10) return 0.01;
      if (p < 50) return 0.05;
      if (p < 100) return 0.1;
      if (p < 500) return 0.5;
      if (p < 1000) return 1.0;
      return 5.0;
    };

    const prices: number[] = [];
    let currentP = limitDown;

    // 解決浮點數誤差，使用乘 100 取整
    while (currentP <= limitUp + 0.0001) {
      prices.push(currentP);
      currentP = Math.round((currentP + getTickSize(currentP)) * 100) / 100;
    }

    // 返回從大到小 (漲停 -> 跌停)
    return prices.reverse();
  };

  const limitUp = quote?.LimitUp || (refPrice ? Math.round(refPrice * 1.1 * 100) / 100 : 0);
  const limitDown = quote?.LimitDown || (refPrice ? Math.round(refPrice * 0.9 * 100) / 100 : 0);

  const fullPrices = useMemo(() => {
    return generateFullPriceRange(refPrice, limitUp, limitDown);
  }, [refPrice, limitUp, limitDown]);

  // 計算均價 (VWAP) 所在的最近 Tick，以及其上下兩檔 (共五檔) 形成的均價帶
  const { avgClosestPrice, avgPriceBand } = useMemo(() => {
    if (!avgPrice || fullPrices.length === 0) return { avgClosestPrice: null, avgPriceBand: [] };

    let closestIdx = -1;
    let minDiff = Infinity;
    for (let i = 0; i < fullPrices.length; i++) {
      const diff = Math.abs(fullPrices[i] - avgPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }

    if (closestIdx === -1) return { avgClosestPrice: null, avgPriceBand: [] };

    const band: number[] = [];
    for (let i = Math.max(0, closestIdx - 2); i <= Math.min(fullPrices.length - 1, closestIdx + 2); i++) {
      band.push(fullPrices[i]);
    }

    return {
      avgClosestPrice: fullPrices[closestIdx],
      avgPriceBand: band
    };
  }, [avgPrice, fullPrices]);

  const placeholderRows = Array.from({ length: 25 });

  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-slate-700/50 overflow-hidden bg-[#0a0a0a] shadow-2xl">
      {/* 頂部控制列 - Compact Condition Bar */}
      <div className="px-3 py-2 bg-[#1C2331] border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">ROD</span>
            <span className="text-xs font-bold text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">現股</span>
          </div>
          <div className="h-4 w-[1px] bg-slate-700"></div>
          <div className="flex items-center gap-1.5 bg-slate-900/50 p-1 rounded border border-slate-700/50">
            <select
              value={orderMode}
              onChange={(e) => setOrderMode(e.target.value as 'Qty' | 'Amount')}
              className="bg-transparent text-xs font-bold text-slate-300 outline-none cursor-pointer appearance-none pl-1"
            >
              <option value="Qty" className="bg-slate-800">張數</option>
              <option value="Amount" className="bg-slate-800">萬</option>
            </select>
            <div className="h-3 w-[1px] bg-slate-600"></div>
            <button onClick={() => setOrderValue(Math.max(1, orderValue - 1))} className="w-5 h-5 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded text-slate-300">-</button>
            <input
              type="number"
              value={orderValue}
              onChange={(e) => setOrderValue(Number(e.target.value))}
              className="w-12 bg-transparent text-center text-sm font-bold text-yellow-500 outline-none"
            />
            <button onClick={() => setOrderValue(orderValue + 1)} className="w-5 h-5 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded text-slate-300">+</button>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {netQty !== 0 && (
            <div className="flex items-center gap-2 px-2 py-0.5 rounded bg-slate-900/50 border border-slate-700">
              <span className={`text-[10px] font-bold ${netQty > 0 ? 'text-red-500' : 'text-green-500'}`}>
                {netQty > 0 ? '多' : '空'} {Math.abs(netQty)}
              </span>
              <span className={`text-[10px] font-mono ${(accountSummary?.["參考損益"] || 0) >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                {(accountSummary?.["參考損益"] || 0) > 0 ? '+' : ''}{accountSummary?.["參考損益"] || 0}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-full ${bidAsk ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`}></div>
            <span className="text-[10px] text-slate-500 font-mono">LIVE</span>
          </div>
        </div>
      </div>

      {/* 主表格區域 */}
      <div ref={tableContainerRef} className="flex-1 overflow-auto custom-scrollbar p-0 relative bg-[#0a0a0a]">
        <table className="w-full border-collapse text-xs font-mono text-center select-none table-fixed">
          <thead className="sticky top-0 z-10 bg-[#0a0a0a] text-slate-400 border-b border-slate-800 shadow-md">
            <tr className="text-[10px] uppercase tracking-tighter">
              <th className="w-[8%] py-1.5 border-r border-slate-800 text-slate-500">刪除</th>
              <th className="w-[14%] py-1.5 border-r border-slate-800 text-red-500/70">欲委託</th>
              <th className="w-[20%] py-1.5 border-r border-slate-800">委託買單</th>
              <th className="w-[16%] py-1.5 border-r border-slate-800 bg-slate-900/30">股價</th>
              <th className="w-[20%] py-1.5 border-r border-slate-800">委託賣單</th>
              <th className="w-[14%] py-1.5 border-r border-slate-800 text-green-500/70">欲委託</th>
              <th className="w-[8%] py-1.5 text-slate-500">刪除</th>
            </tr>
          </thead>
          <tbody>
            {(fullPrices && fullPrices.length > 0) ? (
              fullPrices.map((price) => {
                const askIdx = bidAsk?.AskPrice?.indexOf(price) ?? -1;
                const bidIdx = bidAsk?.BidPrice?.indexOf(price) ?? -1;

                const askVol = askIdx !== -1 ? (bidAsk?.AskVolume?.[askIdx] || 0) : 0;
                const bidVol = bidIdx !== -1 ? (bidAsk?.BidVolume?.[bidIdx] || 0) : 0;
                const askDiff = askIdx !== -1 ? (bidAsk?.DiffAskVol?.[askIdx] || 0) : 0;
                const bidDiff = bidIdx !== -1 ? (bidAsk?.DiffBidVol?.[bidIdx] || 0) : 0;

                const isCurrent = currentPrice === price;
                const isAvgCenter = avgClosestPrice === price;
                const isAvgBand = avgPriceBand.includes(price);

                const askWidthPct = Math.min((askVol / maxVolume) * 100, 100);
                const bidWidthPct = Math.min((bidVol / maxVolume) * 100, 100);

                return (
                  <tr
                    key={price}
                    ref={isCurrent ? currentPriceRef : null}
                    className={`h-7 border-b border-slate-900 group transition-colors ${isCurrent ? 'bg-red-600' : 'hover:bg-slate-800/30'} ${isAvgBand && !isCurrent ? 'bg-cyan-900/20' : ''}`}
                  >
                    {/* 刪除買 */}
                    <td className="text-[10px] text-slate-700 hover:text-red-500 cursor-pointer active:bg-red-500/10 transition-colors border-r border-slate-900/50" onClick={() => handleCancelAll('Buy')}>DEL</td>
                    {/* 欲委託買單 */}
                    <td
                      className="cursor-pointer bg-red-950/20 hover:bg-red-900/40 text-red-500 font-bold transition-colors border-r border-slate-800/50 relative overflow-hidden group/order"
                      onClick={() => handlePlaceOrder('Buy', price)}
                    >
                      <span className="opacity-40 group-hover/order:opacity-100 group-hover/order:scale-110 inline-block transition-all">{calculateFinalQty(price)}</span>
                    </td>
                    {/* 委買量 */}
                    <td className={`font-bold relative z-0 overflow-hidden ${isCurrent ? 'text-white' : 'text-slate-200'} ${bidDiff > 0 ? 'animate-flash-inc' : bidDiff < 0 ? 'animate-flash-dec' : ''}`}>
                      <div className="absolute inset-y-0.5 right-0 bg-red-500/20 transition-colors" style={{ width: `${bidWidthPct}%` }}></div>
                      <span className="relative z-10 drop-shadow-md">{bidVol || ''}</span>
                    </td>

                    {/* 價格 */}
                    <td className={`font-medium relative overflow-hidden transition-colors ${isCurrent ? 'text-white' : `bg-[#0a0a0a] ${getPriceColor(price)}`} border-l border-r border-slate-800/50`}>
                      <div className="flex items-center justify-center gap-1">
                        {price === highPrice && <span className="text-[8px] text-red-500 font-bold absolute left-1">H</span>}
                        {price === lowPrice && <span className="text-[8px] text-green-500 font-bold absolute left-1">L</span>}
                        {renderPrice(price)}
                        {isAvgCenter && <div className="absolute right-0.5 top-0.5 w-1 h-1 bg-cyan-400 rounded-full shadow-[0_0_4px_rgba(34,211,238,0.8)]"></div>}
                        {isAvgBand && !isAvgCenter && <div className="absolute right-1 top-1 w-0.5 h-0.5 bg-cyan-600/50 rounded-full"></div>}
                      </div>
                    </td>

                    {/* 委賣量 */}
                    <td className={`font-bold relative z-0 overflow-hidden ${isCurrent ? 'text-white' : 'text-slate-200'} ${askDiff > 0 ? 'animate-flash-inc' : askDiff < 0 ? 'animate-flash-dec' : ''}`}>
                      <div className="absolute inset-y-0.5 left-0 bg-green-500/20 transition-colors" style={{ width: `${askWidthPct}%` }}></div>
                      <span className="relative z-10 drop-shadow-md">{askVol || ''}</span>
                    </td>
                    {/* 欲委託賣單 */}
                    <td
                      className="cursor-pointer bg-green-950/20 hover:bg-green-900/40 text-green-500 font-bold transition-colors border-l border-slate-800/50 relative overflow-hidden group/order"
                      onClick={() => handlePlaceOrder('Sell', price)}
                    >
                      <span className="opacity-40 group-hover/order:opacity-100 group-hover/order:scale-110 inline-block transition-all">{calculateFinalQty(price)}</span>
                    </td>
                    {/* 刪除賣 */}
                    <td className="text-[10px] text-slate-700 hover:text-green-500 cursor-pointer active:bg-green-500/10 transition-colors border-l border-slate-900/50" onClick={() => handleCancelAll('Sell')}>DEL</td>
                  </tr>
                );
              })
            ) : (
              placeholderRows.map((_, i) => (
                <tr key={i} className="h-7 border-b border-slate-900">
                  <td className="border-r border-slate-900"></td>
                  <td className="border-r border-slate-900"></td>
                  <td className="border-r border-slate-900"></td>
                  <td className="border-r border-slate-900"></td>
                  <td className="border-r border-slate-900"></td>
                  <td className="border-r border-slate-900"></td>
                  <td></td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot className="sticky bottom-0 bg-[#0a0a0a] border-t border-slate-800 text-[11px] text-slate-500">
            <tr className="h-6">
              <td colSpan={2} className="border-r border-slate-800">TOTAL</td>
              <td className="border-r border-slate-800 font-bold text-red-500/80">{totalBidVol}</td>
              <td className="border-r border-slate-800 bg-slate-900/20">{(totalBidVol - totalAskVol)}</td>
              <td className="border-r border-slate-800 font-bold text-green-500/80">{totalAskVol}</td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 底部功能鈕 - Pro Battle Bar */}
      <div className="px-1.5 py-1.5 bg-[#0a0a0a] border-t border-slate-800 grid grid-cols-5 gap-1.5 shrink-0">
        <button
          onClick={() => handleCancelAll('Buy')}
          className="bg-slate-900 hover:bg-red-950/40 text-[10px] text-slate-400 hover:text-red-500 py-2 rounded border border-slate-800 transition-all font-bold"
        >
          買全刪
        </button>
        <button
          onClick={() => handleMarketOrder('Buy')}
          className="bg-red-600 hover:bg-red-500 text-[11px] text-white py-2 rounded shadow-lg shadow-red-900/20 transition-all font-black"
        >
          市價買
        </button>

        <button
          onClick={() => setIsCombatMode(!isCombatMode)}
          className={`flex flex-col items-center justify-center rounded border transition-all ${isCombatMode ? 'bg-yellow-500/10 border-yellow-500 text-yellow-500' : 'bg-slate-900 border-slate-800 text-slate-500'}`}
        >
          {isCombatMode ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2V7a5 5 0 00-5-5zM7 7a3 3 0 016 0v2H7V7z" />
            </svg>
          )}
          <span className="text-[7px] font-black leading-none mt-0.5">{isCombatMode ? 'LOCK' : 'SAFE'}</span>
        </button>

        <button
          onClick={() => handleMarketOrder('Sell')}
          className="bg-green-600 hover:bg-green-500 text-[11px] text-white py-2 rounded shadow-lg shadow-green-900/20 transition-all font-black"
        >
          市價賣
        </button>
        <button
          onClick={() => handleCancelAll('Sell')}
          className="bg-slate-900 hover:bg-green-950/40 text-[10px] text-slate-400 hover:text-green-500 py-2 rounded border border-slate-800 transition-all font-bold"
        >
          賣全刪
        </button>
      </div>
    </div >
  );
};

export default DOMPanel;
