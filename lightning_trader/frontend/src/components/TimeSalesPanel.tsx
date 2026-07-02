/**
 * TimeSalesPanel — 逐筆成交 / 內外盤 tape（Sprint 35）
 *
 * 比 QuoteHistory（純 Time/Price/Vol）多了:
 *   - 內外盤主動方著色（外盤紅 / 內盤綠 / 平盤灰）— classifyAggressor
 *   - 大單高亮（量 >= 門檻,門檻可調並存 localStorage）— isBigTrade
 *   - 底部買賣力道條 + delta（外盤量 - 內盤量）— summarizeFlow
 *
 * 資料源:TradingContext.quoteHistory（目標商品最近 50 筆,index 0 為最新）。
 */
import React, { useMemo, useState } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { formatPrice } from '../utils/instrument';
import PanelTitle from './ui/PanelTitle';
import { UP_COLOR, DOWN_COLOR, FLAT_COLOR } from '../utils/priceColor';
import { classifyAggressor, isBigTrade, summarizeFlow, type FlowTick } from '../utils/tickFlow';

const THRESHOLD_KEY = 'lighTrade_tape_threshold';

function loadThreshold(): number {
  try {
    const raw = localStorage.getItem(THRESHOLD_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* noop */ }
  return 50; // 與 DOM 大單門檻一致
}

// ISO 時間字串 → HH:MM:SS（拿不到就原樣回傳）
function fmtTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

const TimeSalesPanel: React.FC = () => {
  const { targetSymbol, quoteHistory } = useTradingContext();
  const [threshold, setThreshold] = useState<number>(loadThreshold);

  const updateThreshold = (v: number) => {
    const n = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    setThreshold(n);
    try { localStorage.setItem(THRESHOLD_KEY, String(n)); } catch { /* noop */ }
  };

  const flowTicks: FlowTick[] = useMemo(
    () => quoteHistory.map((q) => ({ price: q.Price, volume: q.Volume, tickType: q.TickType })),
    [quoteHistory],
  );
  const summary = useMemo(() => summarizeFlow(flowTicks), [flowTicks]);

  const buyPct = Math.round(summary.buyPct);

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <PanelTitle>逐筆成交 ({targetSymbol || '—'})</PanelTitle>
        <label className="flex items-center gap-1 text-[10px] text-slate-500 flex-shrink-0" title="大單高亮門檻（張/口）">
          大單≥
          <input
            type="number"
            min={0}
            value={threshold}
            onChange={(e) => updateThreshold(Number(e.target.value))}
            className="w-12 bg-slate-900 text-slate-200 text-[10px] font-mono px-1 py-0.5 rounded border border-slate-700 focus:border-[#D4AF37] outline-none"
          />
        </label>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-[11px] text-left font-mono tabular-nums">
          <thead className="text-slate-500 bg-[#1C2331] sticky top-0 z-10">
            <tr>
              <th className="px-2 py-1.5 font-medium">時間</th>
              <th className="px-2 py-1.5 text-right font-medium">成交</th>
              <th className="px-2 py-1.5 text-right font-medium">量</th>
              <th className="px-2 py-1.5 text-center font-medium w-8">內外</th>
            </tr>
          </thead>
          <tbody>
            {quoteHistory.length === 0 ? (
              <tr><td colSpan={4} className="px-2 py-10 text-center text-slate-600 italic">尚無成交資料</td></tr>
            ) : quoteHistory.map((q, idx) => {
              const prevPrice = quoteHistory[idx + 1]?.Price;
              const side = classifyAggressor(q.TickType, q.Price, prevPrice);
              const big = isBigTrade(q.Volume, threshold);
              const color = side === 'buy' ? UP_COLOR : side === 'sell' ? DOWN_COLOR : FLAT_COLOR;
              return (
                <tr key={idx} className={`border-b border-slate-800/40 hover:bg-slate-800/60 ${big ? 'bg-amber-500/10' : ''}`}>
                  <td className="px-2 py-0.5 text-slate-500">{fmtTime(q.TickTime)}</td>
                  <td className={`px-2 py-0.5 text-right font-bold ${color}`}>{q.Price > 0 ? formatPrice(q.Price, q.Symbol || targetSymbol) : '—'}</td>
                  <td className={`px-2 py-0.5 text-right ${big ? 'text-amber-300 font-bold' : 'text-slate-300'}`}>
                    {big && <span className="mr-0.5">●</span>}{q.Volume}
                  </td>
                  <td className={`px-2 py-0.5 text-center font-bold ${color}`}>
                    {side === 'buy' ? '外' : side === 'sell' ? '內' : '·'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 底部:買賣力道條 + delta */}
      <div className="px-3 py-1.5 border-t border-slate-700/50 flex items-center gap-2 text-[10px]">
        <div className="flex-1 h-2 rounded-full overflow-hidden bg-emerald-500/30 flex" title={`外盤 ${summary.buyVol} / 內盤 ${summary.sellVol}`}>
          <div className="h-full bg-red-500/70" style={{ width: `${buyPct}%` }} />
        </div>
        <span className="font-mono text-slate-400 flex-shrink-0">
          外 <span className="text-red-400 font-bold">{buyPct}%</span>
        </span>
        <span className="font-mono text-slate-400 flex-shrink-0" title="外盤量 - 內盤量">
          Δ <span className={`font-bold ${summary.delta > 0 ? UP_COLOR : summary.delta < 0 ? DOWN_COLOR : 'text-slate-300'}`}>
            {summary.delta > 0 ? '+' : ''}{summary.delta}
          </span>
        </span>
      </div>
    </div>
  );
};

export default TimeSalesPanel;
