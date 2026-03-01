import React from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { Activity, Settings } from 'lucide-react';

interface HeaderProps {
  onOpenSettings?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onOpenSettings }) => {
  const { isConnected, targetSymbol, subscribe } = useTradingContext();
  const [symInput, setSymInput] = React.useState(targetSymbol);

  const handleSub = (e: React.FormEvent) => {
    e.preventDefault();
    if (symInput) subscribe(symInput);
  };

  return (
    <div className="glass-panel w-full px-5 py-3 rounded-lg flex items-center justify-between border border-slate-700/50 mb-6 transition-all duration-300">
      <div className="flex items-center gap-4">
        <Activity className={`w-6 h-6 ${isConnected ? 'text-[#10B981]' : 'text-red-500'}`} />
        <div>
          <h2 className="text-lg font-black tracking-[0.2em] text-white italic transition-transform hover:scale-105 cursor-default font-mono">LIGHTRADE</h2>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-[#10B981] shadow-[0_0_6px_rgba(16,185,129,0.3)]' : 'bg-[#EF4444]'}`}></div>
            <span className="text-[10px] text-slate-400 font-mono tracking-widest uppercase font-bold">{isConnected ? 'ONLINE' : 'OFFLINE'}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <form onSubmit={handleSub} className="flex items-center gap-3">
          <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold hidden md:block font-mono">Active Symbol</label>
          <div className="flex bg-slate-900 rounded border border-slate-700 overflow-hidden focus-within:border-[#D4AF37] transition-all shadow-inner">
            <input
              type="text"
              value={symInput}
              onChange={(e) => setSymInput(e.target.value)}
              className="bg-transparent text-slate-200 px-3 py-1.5 outline-none font-mono w-24 text-sm placeholder-slate-600 font-bold"
              placeholder="SYMBOL..."
            />
            <button type="submit" className="bg-slate-800 text-slate-400 hover:bg-[#D4AF37] hover:text-white px-3 py-1.5 text-[10px] font-black tracking-tighter border-l border-slate-700 transition-all uppercase">
              LOAD
            </button>
          </div>
        </form>

        <button 
          onClick={onOpenSettings}
          className="p-2 bg-slate-800 text-slate-400 hover:text-[#D4AF37] hover:bg-slate-700 rounded-lg transition-all border border-slate-700 hover:border-[#D4AF37]/50"
          title="系統設定"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};

export default Header;
