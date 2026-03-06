import React, { useMemo } from 'react';
import { getMultiplier } from '../../types';

// 針對數字顯示精度
const formatPrice = (price: number, symbol: string): string => {
  const sym = symbol.toUpperCase();
  if (sym.startsWith('TXF') || sym.startsWith('MXF') || sym.startsWith('TX') || sym.startsWith('MX') || sym.startsWith('UD') || sym.startsWith('MYM')) {
    return price.toFixed(0);
  }
  if (sym.startsWith('NQ') || sym.startsWith('MNQ') || sym.startsWith('ES') || sym.startsWith('MES')) {
    return price.toFixed(2);
  }
  if (price >= 1000) return price.toFixed(0);
  if (price >= 100) return price.toFixed(1);
  return price.toFixed(2);
};

// 台灣與海外期權正確 Tick 級距表
const getTickSize = (price: number, symbol: string): number => {
  const sym = symbol.toUpperCase();
  if (sym.startsWith('TXF') || sym.startsWith('MXF') || sym.startsWith('TX') || sym.startsWith('MX')) return 1;
  if (sym.startsWith('UD') || sym.startsWith('MYM')) return 1;
  if (sym.startsWith('NQ') || sym.startsWith('MNQ')) return 0.25;
  if (sym.startsWith('ES') || sym.startsWith('MES')) return 0.25;

  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.10;
  if (price < 500) return 0.50;
  if (price < 1000) return 1.00;
  if (price >= 10000) return 1.00; 
  return 5.00;
};


interface DOMTableProps {
  fullPrices: number[];
  isStale: boolean;
  qData: any;
  currentPrice: number;
  refPrice: number;
  limitUp: number;
  limitDown: number;
  highPrice: number;
  lowPrice: number;
  targetSymbol: string;
  currentPosition: any;
  flashDir: 'up' | 'down' | null;
  smartOrders: any[];
  workingBuyMap: Map<number, number>;
  workingSellMap: Map<number, number>;
  bData: any;
  orderFeedback: any;
  handleAddStopOrder: (p: number, action: 'Buy'|'Sell') => void;
  handleCancelOrder: (action: 'Buy'|'Sell', p?: number) => void;
  handlePlaceOrder: (p: number, action: 'Buy'|'Sell') => void;
  handleDropOrder: (e: React.DragEvent<HTMLTableCellElement>, p: number, action: 'Buy'|'Sell') => void;
}

export const DOMTable: React.FC<DOMTableProps> = ({
  fullPrices, isStale, qData, currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice,
  targetSymbol, currentPosition, flashDir, smartOrders, workingBuyMap, workingSellMap, bData,
  orderFeedback, handleAddStopOrder, handleCancelOrder, handlePlaceOrder, handleDropOrder
}) => {
  
  // --- BidAsk 查找表重構進 Table 內部以簡化傳遞 ---
  const { bidMap, askMap, diffBidMap, diffAskMap, cumBidMap, cumAskMap, maxCumVolume } = useMemo(() => {
    const pricesB = bData.BidPrice || [];
    const volsB = bData.BidVolume || [];
    const diffsB = bData.DiffBidVol || [];
    
    const pricesA = bData.AskPrice || [];
    const volsA = bData.AskVolume || [];
    const diffsA = bData.DiffAskVol || [];

    const bMap = new Map<number, number>();
    const aMap = new Map<number, number>();
    const dBMap = new Map<number, number>();
    const dAMap = new Map<number, number>();
    const cBMap = new Map<number, number>();
    const cAMap = new Map<number, number>();

    let cumB = 0;
    for (let i = 0; i < pricesB.length; i++) {
        const k = Math.round(pricesB[i] * 100);
        bMap.set(k, volsB[i] || 0);
        dBMap.set(k, diffsB[i] || 0);
        if (pricesB[i] > 0) {
            cumB += (volsB[i] || 0);
            cBMap.set(k, cumB);
        }
    }
    
    let cumA = 0;
    for (let i = 0; i < pricesA.length; i++) {
        const k = Math.round(pricesA[i] * 100);
        aMap.set(k, volsA[i] || 0);
        dAMap.set(k, diffsA[i] || 0);
        if (pricesA[i] > 0) {
            cumA += (volsA[i] || 0);
            cAMap.set(k, cumA);
        }
    }
    
    let m = 1;
    cBMap.forEach(v => { if (v > m) m = v; });
    cAMap.forEach(v => { if (v > m) m = v; });

    return { bidMap: bMap, askMap: aMap, diffBidMap: dBMap, diffAskMap: dAMap, cumBidMap: cBMap, cumAskMap: cAMap, maxCumVolume: m };
  }, [bData]);

  if (fullPrices.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        請輸入商品代碼後按 LOAD 載入
      </div>
    );
  }

  const tradeVol = qData.Volume ?? 0;
  const isBigTrade = tradeVol >= 50 || (currentPrice > 0 && tradeVol * currentPrice * 1000 >= 3000000);
  
  const smartBuyKeys = new Set<number>();
  const smartSellKeys = new Set<number>();
  smartOrders.forEach(o => {
    if (!o.is_active) return;
    const opKey = Math.round(o.trigger_price * 100);
    if (o.action === 'Buy') smartBuyKeys.add(opKey);
    else smartSellKeys.add(opKey);
  });

  return (
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
        {fullPrices.map((p) => {
          const tick = getTickSize(p, targetSymbol);
          const isC = currentPrice > 0 && Math.abs(currentPrice - p) < tick * 0.4;
          const isCostLine = currentPosition && Math.abs(p - currentPosition.price) < (tick * 0.5);
          const isLimitUp = limitUp > 0 && p === limitUp;
          const isLimitDown = limitDown > 0 && p === limitDown;

          let pnlZoneBg = '';
          if (currentPosition && currentPrice > 0 && !isC && !isCostLine) {
            const costPrice = currentPosition.price;
            const isInPnlZone = (currentPrice > costPrice)
              ? (p < currentPrice && p > costPrice)
              : (p > currentPrice && p < costPrice);
            if (isInPnlZone) {
              const totalDist = Math.abs(currentPrice - costPrice);
              const distFromCost = Math.abs(p - costPrice);
              const ratio = totalDist > 0 ? distFromCost / totalDist : 0;
              const isWin = currentPrice > costPrice;
              
              if (ratio > 0.8) pnlZoneBg = isWin ? 'bg-red-500/20 border-y border-red-500/10' : 'bg-emerald-500/20 border-y border-emerald-500/10';
              else if (ratio > 0.4) pnlZoneBg = isWin ? 'bg-red-500/10' : 'bg-emerald-500/10';
              else pnlZoneBg = isWin ? 'bg-red-500/5' : 'bg-emerald-500/5';
            }
          }

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

          const isBuyFb = orderFeedback && orderFeedback.price === p && orderFeedback.action === 'Buy';
          const isSellFb = orderFeedback && orderFeedback.price === p && orderFeedback.action === 'Sell';
          const fbBuyClass = isBuyFb
            ? (orderFeedback!.status === 'success' ? 'bg-red-500/40' : orderFeedback!.status === 'error' ? 'bg-yellow-500/40' : 'bg-red-500/20 animate-pulse')
            : '';
          const fbSellClass = isSellFb
            ? (orderFeedback!.status === 'success' ? 'bg-emerald-500/40' : orderFeedback!.status === 'error' ? 'bg-yellow-500/40' : 'bg-emerald-500/20 animate-pulse')
            : '';

          const smartBuyLine = smartBuyKeys.has(pKey);
          const smartSellLine = smartSellKeys.has(pKey);

          return (
            <tr key={p} data-price={pKey} className={`h-8 transition-none relative ${isC ? (flashDir === 'up' ? 'bg-red-500/30' : flashDir === 'down' ? 'bg-green-500/30' : 'bg-[#D4AF37]/10 border-y border-[#D4AF37]/50 box-border') : 'border-b border-slate-800/80'} ${isLimitUp ? 'border-t-2 border-t-red-600/60' : ''} ${isLimitDown ? 'border-b-2 border-b-emerald-600/60' : ''} ${isCostLine ? 'border-y-2 border-dashed border-amber-500/50' : ''} ${smartBuyLine || smartSellLine ? 'border-y border-dashed border-purple-500/60' : ''} ${pnlZoneBg}`}>
              
              <td className="border-r border-slate-800 hover:bg-slate-700 cursor-pointer"
                onClick={(e) => {
                  if (e.shiftKey) { handleAddStopOrder(p, 'Buy'); return; }
                  myBuyQty > 0 && handleCancelOrder('Buy', p);
                }}>
                {smartBuyLine && <span className="text-purple-400 text-[9px] font-bold select-none">⚡</span>}
                {!smartBuyLine && myBuyQty > 0 && <span className="font-bold text-[10px] text-red-400 hover:text-white transition-colors">✕</span>}
              </td>

              <td className={`bg-red-950/40 text-red-500 font-bold cursor-pointer hover:bg-red-900/60 border-r border-slate-800 transition-colors ${fbBuyClass}`}
                onClick={() => handlePlaceOrder(p, 'Buy')}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={(e) => handleDropOrder(e as any, p, 'Buy')}
              >
                {myBuyQty > 0 && (
                  <span draggable
                    onDragStart={(e) => {
                       e.dataTransfer.setData('application/json', JSON.stringify({ action: 'Buy', oldPriceStr: p.toString() }));
                       e.stopPropagation();
                    }}
                    className="bg-red-600 text-white px-1.5 py-0.5 rounded text-[10px] shadow-sm cursor-grab active:cursor-grabbing inline-block"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {myBuyQty}
                  </span>
                )}
              </td>

              <td className="relative border-r border-slate-800 text-red-400 font-medium bg-red-950/20 overflow-hidden">
                <div className="absolute inset-y-0.5 right-0 bg-gradient-to-l from-red-600/5 to-red-600/30 transition-all" style={{ width: `${bWidth}%` }}></div>
                <div className="relative z-10 flex justify-between items-center px-2">
                  <span className={`text-[9px] font-bold ${diffBv > 0 ? 'text-red-400' : 'text-slate-500'}`}>{diffBv !== 0 ? (diffBv > 0 ? `+${diffBv}` : diffBv) : ''}</span>
                  <span>{bv || ''}</span>
                </div>
              </td>

              <td className={`font-black border-r border-slate-800 text-[13px] overflow-hidden ${isC ? 'bg-[#D4AF37] text-black shadow-[inset_0_0_12px_rgba(212,175,55,0.3)]' : isLimitUp ? 'text-red-400 bg-red-950/30' : isLimitDown ? 'text-emerald-400 bg-emerald-950/30' : (p > refPrice ? 'text-red-500 bg-slate-900/40' : p < refPrice ? 'text-emerald-500 bg-slate-900/40' : 'text-slate-300 bg-slate-900/40')}`}>
                <div className="flex items-center justify-center gap-1 relative w-full h-full text-center">
                  {isLimitUp && !isC && <div className="absolute top-0 right-0 text-[9px] leading-tight text-white bg-red-600 px-1 py-0.5 rounded-bl font-bold z-20 shadow-md transform">漲停</div>}
                  {isLimitDown && !isC && <div className="absolute bottom-0 right-0 text-[9px] leading-tight text-white bg-emerald-600 px-1 py-0.5 rounded-tl font-bold z-20 shadow-md transform">跌停</div>}

                  {isC && tradeVol > 0 && (
                    qData.TickType === 2 ? (
                      <span className={`absolute left-1 text-[10px] font-bold text-emerald-50 bg-emerald-600/90 px-1 rounded-sm shadow-sm transition-all ${isBigTrade ? 'ring-2 ring-emerald-400 shadow-[0_0_10px_rgba(16,185,129,1)] animate-pulse scale-110 z-30' : ''}`}>{tradeVol}</span>
                    ) : (
                      <span className={`absolute right-1 text-[10px] font-bold text-red-50 bg-red-600/90 px-1 rounded-sm shadow-sm transition-all ${isBigTrade ? 'ring-2 ring-red-400 shadow-[0_0_10px_rgba(239,68,68,1)] animate-pulse scale-110 z-30' : ''}`}>{tradeVol}</span>
                    )
                  )}

                  <span className="z-10 flex items-center justify-center tracking-wider min-w-[3rem] px-2 relative font-mono tabular-nums">
                    {formatPrice(p, targetSymbol)}
                    {isCostLine && (
                      <span className="text-[10px] bg-amber-500/20 text-amber-500 px-1 rounded ml-1 font-bold whitespace-nowrap border border-amber-500/30">
                        [COST]
                      </span>
                    )}
                  </span>

                  {p === highPrice && !isC && <span className="text-[9px] text-red-500 font-bold z-10 absolute right-1">H</span>}
                  {p === lowPrice && !isC && <span className="text-[9px] text-emerald-500 font-bold z-10 absolute right-1">L</span>}
                </div>
              </td>

              <td className="relative border-r border-slate-800 text-emerald-400 font-medium bg-emerald-950/20 overflow-hidden">
                <div className="absolute inset-y-0.5 left-0 bg-gradient-to-r from-emerald-600/5 to-emerald-600/30 transition-all" style={{ width: `${aWidth}%` }}></div>
                <div className="relative z-10 flex justify-between items-center px-2">
                  <span>{av || ''}</span>
                  <span className={`text-[9px] font-bold ${diffAv > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>{diffAv !== 0 ? (diffAv > 0 ? `+${diffAv}` : diffAv) : ''}</span>
                </div>
              </td>

              <td className={`bg-emerald-950/40 text-emerald-500 font-bold cursor-pointer hover:bg-emerald-900/60 border-r border-slate-800 transition-colors ${fbSellClass}`}
                onClick={() => handlePlaceOrder(p, 'Sell')}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={(e) => handleDropOrder(e as any, p, 'Sell')}
              >
                {mySellQty > 0 && (
                  <span draggable
                    onDragStart={(e) => {
                       e.dataTransfer.setData('application/json', JSON.stringify({ action: 'Sell', oldPriceStr: p.toString() }));
                       e.stopPropagation();
                    }}
                    className="bg-emerald-600 text-white px-1.5 py-0.5 rounded text-[10px] shadow-sm cursor-grab active:cursor-grabbing inline-block"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {mySellQty}
                  </span>
                )}
              </td>

              <td className="hover:bg-slate-700 cursor-pointer"
                onClick={(e) => {
                  if (e.shiftKey) { handleAddStopOrder(p, 'Sell'); return; }
                  mySellQty > 0 && handleCancelOrder('Sell', p);
                }}>
                {smartSellLine && <span className="text-purple-400 text-[9px] font-bold select-none">⚡</span>}
                {!smartSellLine && mySellQty > 0 && <span className="font-bold text-[10px] text-emerald-400 hover:text-white transition-colors">✕</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};
