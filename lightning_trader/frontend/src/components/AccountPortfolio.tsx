import React from 'react';
import { Wallet, Briefcase, TrendingUp } from 'lucide-react';

const AccountPortfolio: React.FC = () => {
  // Demo data since no API was provided to fetch account details
  const account = {
    balance: 1542000,
    equity: 1563400,
    unrealizedPnL: 21400
  };

  const positions = [
    { symbol: '2330', qty: 2000, avgPrice: 945.0, currentPrice: 955.0, pnl: 20000 },
    { symbol: '2454', qty: 1000, avgPrice: 1100.0, currentPrice: 1101.4, pnl: 1400 },
  ];

  return (
    <div className="glass-panel flex flex-col h-full rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-4 py-3 bg-slate-800/80 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Account Overview</h3>
      </div>
      
      <div className="p-4 grid grid-cols-3 gap-4 border-b border-slate-700/50 bg-slate-800/30">
        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1"><Wallet size={12}/> Balance</div>
          <div className="text-lg font-mono font-medium text-white">{account.balance.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1"><Briefcase size={12}/> Equity</div>
          <div className="text-lg font-mono font-medium text-white">{account.equity.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-xs text-slate-400 flex items-center gap-1"><TrendingUp size={12}/> Unrl. PnL</div>
          <div className={`text-lg font-mono font-bold ${account.unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {account.unrealizedPnL >= 0 ? '+' : ''}{account.unrealizedPnL.toLocaleString()}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar p-0">
        <table className="w-full text-xs text-left font-mono">
          <thead className="text-slate-500 bg-slate-900/50 sticky top-0">
            <tr>
              <th className="px-4 py-2 font-semibold">SYM</th>
              <th className="px-4 py-2 font-semibold text-right">QTY</th>
              <th className="px-4 py-2 font-semibold text-right">AVG</th>
              <th className="px-4 py-2 font-semibold text-right">PNL</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p, idx) => (
              <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-800/50 transition-colors">
                <td className="px-4 py-2 text-slate-200 font-bold">{p.symbol}</td>
                <td className="px-4 py-2 text-right text-slate-400">{p.qty}</td>
                <td className="px-4 py-2 text-right text-slate-400">{p.avgPrice.toFixed(1)}</td>
                <td className={`px-4 py-2 text-right font-bold ${p.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {p.pnl >= 0 ? '+' : ''}{p.pnl.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AccountPortfolio;
