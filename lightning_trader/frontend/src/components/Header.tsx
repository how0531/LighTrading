import React from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { Activity } from 'lucide-react';

const Header: React.FC = () => {
  const { isConnected, targetSymbol, subscribe } = useTradingContext();
  const [symInput, setSymInput] = React.useState(targetSymbol);

  const handleSub = (e: React.FormEvent) => {
    e.preventDefault();
    if(symInput) subscribe(symInput);
  };

  return (
    <div className="glass-panel w-full px-6 py-4 rounded-xl flex items-center justify-between border border-slate-700/50 mb-6">
      <div className="flex items-center gap-4">
        <Activity className={`w-6 h-6 ${isConnected ? 'text-emerald-400 animate-pulse-slow' : 'text-red-400'}`} />
        <div>
          <h2 className="text-xl font-bold tracking-widest text-white">LighTrade</h2>
          <span className="text-xs text-slate-400 font-mono">{isConnected ? 'SYS_ONLINE' : 'SYS_OFFLINE'}</span>
        </div>
      </div>

      <form onSubmit={handleSub} className="flex items-center gap-3">
        <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold hidden md:block">Active Symbol</label>
        <div className="flex bg-slate-900/50 rounded-lg border border-slate-700 overflow-hidden focus-within:border-yellow-500 transition-colors">
          <input 
            type="text" 
            value={symInput}
            onChange={(e) => setSymInput(e.target.value)}
            className="bg-transparent text-white px-4 py-2 outline-none font-mono w-32 placeholder-slate-600"
            placeholder="Symbol..."
          />
          <button type="submit" className="bg-yellow-600 text-white hover:bg-yellow-500 px-4 py-2 text-sm font-bold transition-colors">
            LOAD
          </button>
        </div>
      </form>
    </div>
  );
};

export default Header;
