import React from 'react';

interface DOMFooterProps {
  isSyncing: boolean;
  handleManualSync: () => void;
  handleCancelOrder: (action: 'Buy' | 'Sell') => void;
  handleFlatten: () => void;
  handleReverse: () => void;
}

export const DOMFooter: React.FC<DOMFooterProps> = ({
  isSyncing, handleManualSync, handleCancelOrder, handleFlatten, handleReverse
}) => {
  return (
    <div className="p-3 border-t border-slate-800 bg-[#1c2331] flex justify-end items-center shadow-2xl gap-2 md:gap-4">
      <div className="flex items-center gap-1.5 mr-auto">
        <button 
          onClick={handleManualSync} 
          className={`px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-[10px] font-bold transition-all active:scale-95 shadow-md cursor-pointer ${isSyncing ? 'opacity-50' : ''}`}
        >
          SYNC
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <button onClick={() => handleCancelOrder('Buy')} className="px-2.5 py-1.5 bg-red-900/40 hover:bg-red-800/60 text-red-400 hover:text-red-300 rounded text-[10px] font-bold border border-red-800/50 transition-all active:scale-95 cursor-pointer">全刪買</button>
        <button onClick={() => {
          if (window.confirm('確定要執行平倉 (市價清空所有部位)?')) handleFlatten();
        }} className="px-3 py-1.5 bg-amber-900/40 hover:bg-amber-800/60 text-amber-400 hover:text-amber-300 rounded text-[10px] font-black border border-amber-700/50 transition-all active:scale-95 cursor-pointer">平倉</button>
        <button onClick={() => {
          if (window.confirm('確定要執行反向沖銷 (反手)?\n此操作將市價平倉後立即反向建倉。')) handleReverse();
        }} className="px-3 py-1.5 bg-purple-900/40 hover:bg-purple-800/60 text-purple-400 hover:text-purple-300 rounded text-[10px] font-black border border-purple-700/50 transition-all active:scale-95 cursor-pointer">反手</button>
        <button onClick={() => handleCancelOrder('Sell')} className="px-2.5 py-1.5 bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-400 hover:text-emerald-300 rounded text-[10px] font-bold border border-emerald-800/50 transition-all active:scale-95 cursor-pointer">全刪賣</button>
      </div>
    </div>
  );
};
