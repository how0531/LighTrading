import React from 'react';
import { formatPrice } from '../../utils/instrument';
import { useSettings } from '../../contexts/SettingsContext';
import type { SizingMode } from '../../utils/sizing';
import { lotsToAmount } from '../../utils/sizing';
import { netPnL as computeNetPnL } from '../../utils/fees';
import { getMultiplier } from '../../types';
import { UP_COLOR, DOWN_COLOR } from '../../utils/priceColor';

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
  orderValue: number;
  setOrderValue: (v: number) => void;
  accountEquity: number;
  scrollAnchor: 'price' | 'cost';
  setScrollAnchor: (a: 'price' | 'cost') => void;
  onScrollToAnchor: () => void;
}

function formatNT(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 10_000)}萬`;
  return n.toLocaleString();
}

const MODE_LABEL: Record<SizingMode, string> = {
  lots: '張/口',
  amount: '金額',
  equity_pct: '%權益',
};

export const DOMHeader: React.FC<DOMHeaderProps> = ({
  qData, targetSymbol, currentPrice, refPrice, limitUp, limitDown, isSimulation, fullPrices,
  accounts, activeAccount, selectAccount, currentPosition, realtimePnL,
  orderType, setOrderType, priceType, setPriceType,
  orderCond, setOrderCond, orderLot, setOrderLot,
  orderValue, setOrderValue,
  accountEquity, scrollAnchor, setScrollAnchor, onScrollToAnchor,
}) => {
  const netQty = currentPosition ? (currentPosition.direction === 'Buy' ? currentPosition.qty : -currentPosition.qty) : 0;
  const { settings, updateSetting } = useSettings();
  const sizing = settings.sizing;
  const priceForSizing = currentPrice || refPrice;
  const multiplier = getMultiplier(targetSymbol || '');
  const resolvedAmount = orderValue > 0 && priceForSizing > 0
    ? lotsToAmount(orderValue, { price: priceForSizing, multiplier, equity: 0 })
    : 0;

  const setSizingMode = (mode: SizingMode) => updateSetting({ sizing: { ...sizing, mode } });

  // Sprint 29：淨 PnL — 把現價當立即平倉價估算來回成本
  const cpForNet = currentPrice || refPrice;
  const netRealtimePnL = currentPosition && cpForNet > 0
    ? computeNetPnL(
        realtimePnL,
        currentPosition.symbol || targetSymbol,
        Math.abs(netQty),
        currentPosition.price,
        cpForNet,
        settings.fees,
      )
    : realtimePnL;
  const showNet = settings.showNetPnL;
  const primaryPnL = showNet ? netRealtimePnL : realtimePnL;
  const secondaryPnL = showNet ? realtimePnL : netRealtimePnL;

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

          <div className={`flex flex-col items-center justify-center px-3 py-1 rounded border gap-0.5 ${primaryPnL >= 0 ? 'bg-red-900/20 border-red-800/50' : 'bg-emerald-900/20 border-emerald-800/50'}`}>
            <div className="flex items-center gap-1.5 w-full justify-between">
              <button
                onClick={() => updateSetting({ showNetPnL: !showNet })}
                className="text-[8px] opacity-70 hover:opacity-100 uppercase font-bold leading-none cursor-pointer transition-opacity"
                title="點擊切換 毛 / 淨（扣手續費+稅後）"
              >
                {showNet ? '淨 PnL' : '毛 PnL'}
              </button>
              {currentPosition && (currentPrice > 0 || refPrice > 0) && (
                <span className={`text-[9px] font-mono font-bold leading-none tracking-tighter ${primaryPnL >= 0 ? 'text-red-500/80' : 'text-emerald-500/80'}`}>
                  {(() => {
                    const cp = currentPrice || refPrice;
                    const pts = (cp - currentPosition.price) * (currentPosition.direction === 'Buy' ? 1 : -1);
                    return `${pts > 0 ? '+' : ''}${parseFloat(pts.toFixed(2))} 點/口`;
                  })()}
                </span>
              )}
            </div>
            <span key={primaryPnL} className={`inline-block pnl-animate text-sm font-mono font-black leading-none tabular-nums ${primaryPnL >= 0 ? 'text-red-400 drop-shadow-[0_0_5px_rgba(248,113,113,0.3)]' : 'text-emerald-400 drop-shadow-[0_0_5px_rgba(52,211,153,0.3)]'}`}>
              {primaryPnL > 0 ? '+' : ''}{primaryPnL.toLocaleString()}
            </span>
            {currentPosition && netRealtimePnL !== realtimePnL && (
              <span className="text-[9px] font-mono text-slate-500 leading-none tabular-nums">
                {showNet ? '毛' : '淨'} {secondaryPnL > 0 ? '+' : ''}{secondaryPnL.toLocaleString()}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {(qData.AvgPrice ?? 0) > 0 && (
            <div className="flex flex-col items-center px-2 py-1 rounded border border-slate-700 bg-slate-800/60">
              <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">VWAP</span>
              <span className={`text-[12px] font-mono font-black tabular-nums leading-none ${currentPrice > (qData.AvgPrice ?? 0) ? UP_COLOR : currentPrice < (qData.AvgPrice ?? 0) ? DOWN_COLOR : 'text-[#D4AF37]'}`}>
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
              {/* BACKLOG B9：置中錨點 — 現價 / 持倉成本 */}
              <div className="flex items-center bg-[#101623] rounded border border-slate-700 overflow-hidden">
                {([
                  { id: 'price' as const, label: '現價' },
                  { id: 'cost' as const, label: '成本' },
                ]).map((opt) => {
                  const costDisabled = opt.id === 'cost' && !(currentPosition && currentPosition.price > 0);
                  return (
                    <button
                      key={opt.id}
                      disabled={costDisabled}
                      onClick={() => setScrollAnchor(opt.id)}
                      title={costDisabled ? '無持倉，無成本價' : `置中錨點：${opt.label}`}
                      className={`px-1.5 py-0.5 text-[10px] font-bold transition-colors ${
                        scrollAnchor === opt.id
                          ? 'bg-[#D4AF37] text-[#101623]'
                          : costDisabled
                            ? 'text-slate-700 cursor-not-allowed'
                            : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={onScrollToAnchor}
                className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] rounded border border-slate-600 transition-colors shadow-sm focus:outline-none"
                title={scrollAnchor === 'cost' ? '捲動至持倉成本價' : '捲動至當前價格'}
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

        {/* Sprint 28：Sizing — 三模式（張/口、金額、% 權益），mode 持久於 settings */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest hidden md:block">Sizing</span>
            <div className="flex bg-[#101623] rounded border border-slate-700 overflow-hidden">
              {(['lots', 'amount', 'equity_pct'] as SizingMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setSizingMode(m)}
                  className={`px-2 py-0.5 text-[10px] font-bold transition-colors ${
                    sizing.mode === m
                      ? 'bg-[#D4AF37] text-[#101623]'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {sizing.mode === 'lots' && (
              <>
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
                {resolvedAmount > 0 && (
                  <span className="text-[9px] text-slate-500 font-mono">≈ {formatNT(resolvedAmount)}</span>
                )}
              </>
            )}

            {sizing.mode === 'amount' && (
              <>
                <div className="flex items-center bg-[#101623] rounded border border-slate-700 overflow-hidden focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500">
                  <span className="px-1.5 text-[10px] text-slate-500 font-bold">NT$</span>
                  <input
                    type="number"
                    value={sizing.amount}
                    onChange={(e) => updateSetting({ sizing: { ...sizing, amount: Math.max(0, Number(e.target.value) || 0) } })}
                    className="w-24 bg-transparent text-right text-slate-200 px-1 py-1 text-[11px] font-mono focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
                <div className="flex gap-1">
                  {sizing.amountPresets.map(amt => (
                    <button
                      key={`amt-${amt}`}
                      onClick={() => updateSetting({ sizing: { ...sizing, amount: amt } })}
                      className={`px-1.5 py-1 rounded text-[10px] font-bold transition-colors border cursor-pointer shadow-sm ${
                        sizing.amount === amt
                          ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/50'
                          : 'bg-[#101623] hover:bg-slate-700 text-slate-300 border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      {formatNT(amt)}
                    </button>
                  ))}
                </div>
                <span className="text-[10px] font-mono font-bold tabular-nums px-1.5 py-1 rounded bg-[#D4AF37]/10 text-[#D4AF37] border border-[#D4AF37]/30">
                  → {orderValue > 0 ? `${orderValue} ${multiplier === 1000 ? '張' : '口'}` : '—'}
                </span>
              </>
            )}

            {sizing.mode === 'equity_pct' && (
              <>
                <div className="flex items-center bg-[#101623] rounded border border-slate-700 overflow-hidden focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500">
                  <input
                    type="number"
                    value={sizing.equityPct}
                    min={1}
                    max={100}
                    onChange={(e) => updateSetting({ sizing: { ...sizing, equityPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } })}
                    className="w-12 bg-transparent text-right text-slate-200 px-1 py-1 text-[11px] font-mono focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="px-1.5 text-[10px] text-slate-500 font-bold">%</span>
                </div>
                <div className="flex gap-1">
                  {sizing.equityPctPresets.map(pct => (
                    <button
                      key={`pct-${pct}`}
                      onClick={() => updateSetting({ sizing: { ...sizing, equityPct: pct } })}
                      className={`px-1.5 py-1 rounded text-[10px] font-bold transition-colors border cursor-pointer shadow-sm ${
                        sizing.equityPct === pct
                          ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/50'
                          : 'bg-[#101623] hover:bg-slate-700 text-slate-300 border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
                {accountEquity > 0 ? (
                  <span className="text-[10px] font-mono font-bold tabular-nums px-1.5 py-1 rounded bg-[#D4AF37]/10 text-[#D4AF37] border border-[#D4AF37]/30">
                    → {orderValue > 0 ? `${orderValue} ${multiplier === 1000 ? '張' : '口'}` : '—'}
                    <span className="text-slate-500 font-normal ml-1">({formatNT(accountEquity * sizing.equityPct / 100)})</span>
                  </span>
                ) : (
                  <span className="text-[9px] text-amber-400/80 italic">等待帳戶餘額…</span>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
