import React from 'react';
import { useQuotes } from '../contexts/TradingContext';
import { formatPrice } from '../utils/instrument';

// ISO 時間字串 → HH:MM:SS（拿不到就原樣回傳；與 TimeSalesPanel 同邏輯）
function fmtTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

// 未虛擬化 → 渲染上限（TradingContext 資料保留 500 筆）
const RENDER_MAX = 200;

const QuoteHistory: React.FC = () => {
  const { quoteHistory } = useQuotes();
  const visible = quoteHistory.length > RENDER_MAX ? quoteHistory.slice(0, RENDER_MAX) : quoteHistory;

  return (
    <div className="glass-panel flex flex-col h-full rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-4 py-3 bg-slate-800/80 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Tick Stream</h3>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-xs text-left font-mono">
          <thead className="text-slate-400 bg-slate-900/50 sticky top-0 shadow-sm">
            <tr>
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2 text-right">Price</th>
              <th className="px-4 py-2 text-right">Vol</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((q, idx) => {
              const prevPrice = idx < quoteHistory.length - 1 ? quoteHistory[idx + 1].Price : q.Price;
              // 台股慣例：紅漲 / 綠跌 / 平盤灰（與 WatchlistPanel 一致）
              const up = q.Price > prevPrice;
              const down = q.Price < prevPrice;
              const priceColor = up ? 'text-red-400' : down ? 'text-emerald-400' : 'text-slate-300';

              return (
                // Seq = TradingContext 指派的穩定 key（避免 prepend 造成整列 re-key）
                <tr key={q.Seq ?? `f${idx}`} className="border-b border-slate-800/50 hover:bg-slate-800/80 transition-colors">
                  <td className="px-4 py-2 text-slate-500">{fmtTime(q.TickTime)}</td>
                  <td className={`px-4 py-2 text-right font-bold ${priceColor}`}>
                    {formatPrice(q.Price, q.Symbol)}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-300">{q.Volume}</td>
                </tr>
              )
            })}
            {quoteHistory.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-slate-500 italic">No ticks received yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default QuoteHistory;
