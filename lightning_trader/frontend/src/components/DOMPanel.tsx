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
    ...(bidAsk?.BidVolume || ([] as number[])),
    ...(bidAsk?.AskVolume || ([] as number[])),
    1
  ), [bidAsk]);

  const totalBidVol = useMemo(() => (bidAsk?.BidVolume || ([] as number[])).reduce((a, b) => a + b, 0), [bidAsk]);
  const totalAskVol = useMemo(() => (bidAsk?.AskVolume || ([] as number[])).reduce((a, b) => a + b, 0), [bidAsk]);

  const getPriceColor = (p: number) => {
    if (!refPrice || p === refPrice) return 'text-slate-100';
    return p > refPrice ? 'text-rose-400' : 'text-emerald-400';
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
    <div className="flex flex-col flex-1 min-h-0 rounded-lg border border-slate-800 overflow-hidden bg-slate-950 shadow-2xl">
      {/* 頂部控制列 - Compact Condition Bar */}
      <div className="px-3 py-2 bg-slate-900/50 border-b border-slate-800/80 flex items-center justify-between shrink-0">
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
      <div ref={tableContainerRef} className="flex-1 overflow-auto custom-scrollbar p-0 relative bg-slate-950">
        <table className="w-full border-collapse text-xs font-mono text-center select-none table-fixed tabular-nums">
          <thead className="sticky top-0 z-10 bg-slate-900 text-slate-500 border-b border-slate-700">
            <tr className="text-[10px] uppercase tracking-wider font-bold">
              <th className="w-[8%] py-1.5 border-r border-slate-800">Del</th>
              <th className="w-[14%] py-1.5 border-r border-slate-800 font-sans font-normal opacity-70">Pre-Buy</th>
              <th className="w-[20%] py-1.5 border-r border-slate-800">Bid Vol</th>
              <th className="w-[16%] py-1.5 border-r border-slate-800 bg-slate-800/50">Price</th>
              <th className="w-[20%] py-1.5 border-r border-slate-800">Ask Vol</th>
              <th className="w-[14%] py-1.5 border-r border-slate-800 font-sans font-normal opacity-70">Pre-Sell</th>
              <th className="w-[8%] py-1.5">Del</th>
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
                    key={String(price)}
                    ref={isCurrent ? currentPriceRef : null}
                    className={`h-7 border-b border-slate-900/40 transition-colors ${isCurrent ? 'bg-slate-800' : 'hover:bg-slate-900/60'} ${isAvgBand && !isCurrent ? 'bg-cyan-950/20' : ''}`}
                  >
                    {/* 刪除買 */}
                    <td className="text-[10px] text-slate-600 hover:text-white hover:bg-rose-900 cursor-pointer transition-colors border-r border-slate-900/50" onClick={() => handleCancelAll('Buy')}>✕</td>
                    {/* 欲委託買單 */}
                    <td
                      className="cursor-pointer bg-slate-950 hover:bg-rose-950/40 text-rose-500 font-bold transition-colors border-r border-slate-800/50 relative overflow-hidden group/order"
                      onClick={() => handlePlaceOrder('Buy', price)}
                    >
                      <span className="opacity-30 group-hover/order:opacity-100 transition-opacity">{calculateFinalQty(price)}</span>
                    </td>
                    {/* 價格 */}
                    <td key={`price-${isCurrent ? quote?.Price : price}`} className={`font-semibold relative overflow-hidden transition-colors ${isCurrent ? 'text-[#D4AF37] bg-slate-800 animate-tick' : `bg-slate-900/80 ${getPriceColor(price)}`} border-l border-r border-slate-800/50`}>
                      <div className="flex items-center justify-center gap-1">
                        {price === highPrice && <span className="text-[8px] text-red-500 absolute left-1 opacity-60">H</span>}
                        {price === lowPrice && <span className="text-[8px] text-emerald-500 absolute left-1 opacity-60">L</span>}
                        {renderPrice(price)}
                        {isAvgCenter && <div className="absolute right-0.5 top-0.5 w-1 h-1 bg-cyan-700 rounded-full"></div>}
                      </div>
                    </td>

                    {/* 委賣量 */}
                    <td className={`font-bold relative z-0 overflow-hidden ${isCurrent ? 'text-[#D4AF37] font-black' : 'text-slate-200'}`}>
                      <div className="absolute inset-y-0.5 left-0 bg-emerald-500/15 transition-all duration-150 ease-out" style={{ width: `${askWidthPct}%` }}></div>
                      <span key={`ask-${askVol}`} className={`relative z-10 ${askDiff > 0 ? 'animate-flash-inc' : askDiff < 0 ? 'animate-flash-dec' : ''}`}>{askVol || ''}</span>
                    </td>
                    {/* 欲委託賣單 */}
                    <td
                      className="cursor-pointer bg-slate-950 hover:bg-emerald-950/40 text-emerald-500 font-bold transition-colors border-l border-slate-800/50 relative overflow-hidden group/order"
                      onClick={() => handlePlaceOrder('Sell', price)}
                    >
                      <span className="opacity-30 group-hover/order:opacity-100 transition-opacity">{calculateFinalQty(price)}</span>
                    </td>
                    {/* 刪除賣 */}
                    <td className="text-[10px] text-slate-600 hover:text-white hover:bg-emerald-900 cursor-pointer transition-colors border-l border-slate-900/50" onClick={() => handleCancelAll('Sell')}>✕</td>
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
          <tfoot className="sticky bottom-0 bg-slate-950 border-t border-slate-800 text-[11px] text-slate-500">
            <tr className="h-6">
              <td colSpan={2} className="border-r border-slate-900/50">TOTAL</td>
              <td className="border-r border-slate-900/50 font-bold text-rose-500/60">{totalBidVol}</td>
              <td className="border-r border-slate-900/50 bg-slate-900/40">{(totalBidVol - totalAskVol)}</td>
              <td className="border-r border-slate-900/50 font-bold text-emerald-500/60">{totalAskVol}</td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 底部功能鈕 - Pro Battle Bar */}
      <div className="px-2 py-2 bg-slate-950 border-t border-slate-800 grid grid-cols-[1fr_2fr_1.5fr_2fr_1fr] gap-2 shrink-0">
        <button
          onClick={() => handleCancelAll('Buy')}
          className="bg-slate-900 hover:bg-rose-950/50 text-[11px] text-slate-400 hover:text-rose-400 py-2 rounded focus:outline-none focus:ring-1 focus:ring-slate-700 transition-all font-sans"
        >
          買全刪
        </button>
        <button
          onClick={() => handleMarketOrder('Buy')}
          className="bg-rose-800 hover:bg-rose-700 text-[12px] text-white py-2 rounded shadow-sm shadow-rose-950/50 transition-all font-sans"
        >
          市價買進
        </button>

        <button
          onClick={() => setIsCombatMode(!isCombatMode)}
          className={`flex flex-col items-center justify-center rounded border transition-all ${isCombatMode ? 'bg-[#D4AF37]/10 border-[#D4AF37] text-[#D4AF37]' : 'bg-slate-900 border-slate-800 text-slate-500'}`}
        >
          <span className="text-[10px] font-sans font-medium">{isCombatMode ? '🔒 Locked' : '⚡ 1-Click'}</span>
        </button>

        <button
          onClick={() => handleMarketOrder('Sell')}
          className="bg-emerald-800 hover:bg-emerald-700 text-[12px] text-white py-2 rounded shadow-sm shadow-emerald-950/50 transition-all font-sans"
        >
          市價賣出
        </button>
        <button
          onClick={() => handleCancelAll('Sell')}
          className="bg-slate-900 hover:bg-emerald-950/50 text-[11px] text-slate-400 hover:text-emerald-400 py-2 rounded focus:outline-none focus:ring-1 focus:ring-slate-700 transition-all font-sans"
        >
          賣全刪
        </button>
      </div>
    </div >
  );
};

export default DOMPanel;
