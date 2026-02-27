import React from 'react';
import { useTradingContext } from '../contexts/TradingContext';

const QuoteHistory: React.FC = () => {
  const { quoteHistory } = useTradingContext();

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
            {quoteHistory.map((q, idx) => {
              const prevPrice = idx < quoteHistory.length - 1 ? quoteHistory[idx+1].Price : q.Price;
              const isUp = q.Price >= prevPrice;
              
              return (
                <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-800/80 transition-colors">
                  <td className="px-4 py-2 text-slate-500">{q.Time}</td>
                  <td className={`px-4 py-2 text-right font-bold ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                    {q.Price.toFixed(2)}
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
