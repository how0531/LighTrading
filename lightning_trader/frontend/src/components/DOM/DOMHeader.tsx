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

interface DOMHeaderProps {
  qData: any;
  targetSymbol: string;
  currentPrice: number;
  refPrice: number;
  limitUp: number;
  limitDown: number;
  isSimulation: boolean;
  fullPrices: number[];
  accounts: any[];
  activeAccount: string | null;
  selectAccount: (acc: string) => void;
  currentPosition: any;
  realtimePnL: number;
  orderType: string;
  setOrderType: (v: string) => void;
  priceType: string;
  setPriceType: (v: string) => void;
  orderCond: string;
  setOrderCond: (v: string) => void;
  orderLot: string;
  setOrderLot: (v: string) => void;
  calcAmount: number | '';
  setCalcAmount: (v: number | '') => void;
  handleAmountConvert: (amt: number | '') => void;
  orderValue: number;
  setOrderValue: (v: number) => void;
  scrollToCurrentPrice: () => void;
}

export const DOMHeader: React.FC<DOMHeaderProps> = ({
  qData, targetSymbol, currentPrice, refPrice, limitUp, limitDown, isSimulation, fullPrices,
  accounts, activeAccount, selectAccount, currentPosition, realtimePnL,
  orderType, setOrderType, priceType, setPriceType,
  orderCond, setOrderCond, orderLot, setOrderLot,
  calcAmount, setCalcAmount, handleAmountConvert,
  orderValue, setOrderValue, scrollToCurrentPrice
}) => {
  const netQty = currentPosition ? (currentPosition.direction === 'Buy' ? currentPosition.qty : -currentPosition.qty) : 0;

  return (
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

          <div className={`flex flex-col items-center justify-center px-3 py-1 rounded border gap-0.5 ${realtimePnL >= 0 ? 'bg-red-900/20 border-red-800/50' : 'bg-emerald-900/20 border-emerald-800/50'}`}>
            <div className="flex items-center gap-1.5 w-full justify-between">
              <span className="text-[8px] opacity-70 uppercase font-bold leading-none">PnL</span>
              {currentPosition && (currentPrice > 0 || refPrice > 0) && (
                <span className={`text-[9px] font-mono font-bold leading-none tracking-tighter ${realtimePnL >= 0 ? 'text-red-500/80' : 'text-emerald-500/80'}`}>
                  {(() => {
                    const cp = currentPrice || refPrice;
                    const pts = (cp - currentPosition.price) * (currentPosition.direction === 'Buy' ? 1 : -1);
                    return `${pts > 0 ? '+' : ''}${parseFloat(pts.toFixed(2))} 點/口`;
                  })()}
                </span>
              )}
            </div>
            <span key={realtimePnL} className={`inline-block pnl-animate text-sm font-mono font-black leading-none tabular-nums ${realtimePnL >= 0 ? 'text-red-400 drop-shadow-[0_0_5px_rgba(248,113,113,0.3)]' : 'text-emerald-400 drop-shadow-[0_0_5px_rgba(52,211,153,0.3)]'}`}>
              {realtimePnL > 0 ? '+' : ''}{realtimePnL.toLocaleString()}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {(qData.AvgPrice ?? 0) > 0 && (
            <div className="flex flex-col items-center px-2 py-1 rounded border border-slate-700 bg-slate-800/60">
              <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">VWAP</span>
              <span className={`text-[12px] font-mono font-black tabular-nums leading-none ${currentPrice > (qData.AvgPrice ?? 0) ? 'text-red-400' : currentPrice < (qData.AvgPrice ?? 0) ? 'text-emerald-400' : 'text-[#D4AF37]'}`}>
                {formatPrice(qData.AvgPrice ?? 0, targetSymbol)}
              </span>
            </div>
          )}

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

      {/* Row 2: Order Settings */}
      <div className="px-4 py-2 border-b border-slate-800 bg-[#151b26] flex flex-wrap items-center gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">Time in Force</span>
          <select value={orderType} onChange={(e) => setOrderType(e.target.value)} className="bg-[#101623] border border-slate-700 hover:border-slate-600 rounded text-[11px] font-bold py-1 px-1.5 text-slate-200 outline-none cursor-pointer focus:ring-1 focus:ring-slate-500">
            <option value="ROD">ROD</option>
            <option value="IOC">IOC (立即成交否則取消)</option>
            <option value="FOK">FOK (全部成交否則取消)</option>
          </select>
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">Price Type</span>
          <select value={priceType} onChange={(e) => setPriceType(e.target.value)} className="bg-[#101623] border border-slate-700 hover:border-slate-600 rounded text-[11px] font-bold py-1 px-1.5 text-[#D4AF37] outline-none cursor-pointer focus:ring-1 focus:ring-slate-500">
            <option value="LMT">LMT (限價)</option>
            <option value="MKT">MKT (市價)</option>
            <option value="MKP">MKP (範圍市價)</option>
          </select>
        </div>

        {targetSymbol && targetSymbol.length >= 4 && !isNaN(Number(targetSymbol)) && (
          <>
            <div className="flex flex-col gap-0.5">
              <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">Credit</span>
              <select value={orderCond} onChange={(e) => setOrderCond(e.target.value)} className="bg-[#101623] border border-slate-700 hover:border-slate-600 rounded text-[11px] font-bold py-1 px-1.5 text-slate-300 outline-none cursor-pointer focus:ring-1 focus:ring-slate-500">
                <option value="Cash">現股</option>
                <option value="MarginTrading">融資</option>
                <option value="ShortSelling">融券</option>
              </select>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">Lot Size</span>
              <select value={orderLot} onChange={(e) => setOrderLot(e.target.value)} className="bg-[#101623] border border-slate-700 hover:border-slate-600 rounded text-[11px] font-bold py-1 px-1.5 text-slate-300 outline-none cursor-pointer focus:ring-1 focus:ring-slate-500">
                <option value="Common">整股 (1張)</option>
                <option value="IntradayOdd">盤中零股 (1股)</option>
              </select>
            </div>
          </>
        )}

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
              <button onClick={() => handleAmountConvert(calcAmount)} className="bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white px-2 py-1 text-[10px] font-bold border-l border-slate-700 transition-colors">
                換算
              </button>
            </div>
            <div className="flex gap-1">
              {[10, 20, 50, 100].map(amt => (
                <button
                  key={`amt-${amt}`}
                  onClick={() => { const val = amt * 10000; setCalcAmount(val); handleAmountConvert(val); }}
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
              <button onClick={() => setOrderValue(Math.max(1, orderValue - 1))} className="w-6 h-6 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors cursor-pointer text-sm font-black leading-none">-</button>
              <input type="number" value={orderValue} onChange={(e) => setOrderValue(Math.max(1, Number(e.target.value)))} className="w-10 bg-transparent text-center text-[#D4AF37] text-[13px] font-black focus:outline-none tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
              <button onClick={() => setOrderValue(orderValue + 1)} className="w-6 h-6 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors cursor-pointer text-sm font-black leading-none">+</button>
            </div>
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
  );
};
