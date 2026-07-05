import React from 'react';
import { useSettings } from '../../contexts/SettingsContext';

interface DOMFooterProps {
  isSyncing: boolean;
  handleManualSync: () => void;
  handleCancelOrder: (action: 'Buy' | 'Sell') => void;
  handleFlatten: () => void;
  handleReverse: () => void;
}

const displayKey = (key: string) => (key === ' ' ? 'Space' : key);

const ACTION_LABEL: Record<string, string> = {
  Buy: '買',
  Sell: '賣',
  CancelAll: '全刪',
  Flatten: '平倉',
  ScrollCenter: '置中',
};

const DOMFooterInner: React.FC<DOMFooterProps> = ({
  isSyncing, handleManualSync, handleCancelOrder, handleFlatten, handleReverse
}) => {
  const { settings } = useSettings();

  // 確認流統一（UX 批次 3）：確認只做一層，由 DOMPanel 的 handleFlatten /
  // handleReverse 用 ConfirmDialog 問（它才知道 targetSymbol，且尊重戰鬥模式）。
  // 原本這裡再包一層 toast.warn 確認會造成「toast 確認 + confirm 對話框」跳兩次。

  return (
    <div className="border-t border-slate-800 bg-[#1c2331]">
      {/* 快捷鍵提示條 */}
      <div className="px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-800/70 text-[10px] text-slate-500">
        <span className="font-bold tracking-widest uppercase text-slate-600">Hotkeys</span>
        {settings.hotkeys.map((hk, idx) => (
          <span key={idx} className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-slate-800/80 border border-slate-700 rounded text-[9px] font-mono text-[#D4AF37] tracking-wide">
              {displayKey(hk.key)}
            </kbd>
            <span className="text-slate-400">{ACTION_LABEL[hk.action] || hk.action}</span>
          </span>
        ))}
        <span className="flex items-center gap-1 ml-auto opacity-70">
          <kbd className="px-1 py-0.5 bg-slate-800/80 border border-slate-700 rounded text-[9px] font-mono text-slate-300">?</kbd>
          <span className="text-slate-500">全部速查表</span>
        </span>
      </div>

      {/* 主操作列 */}
      <div className="p-3 flex justify-end items-center shadow-2xl gap-2 md:gap-4">
        <div className="flex items-center gap-1.5 mr-auto">
          <button
            onClick={handleManualSync}
            className={`px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-[10px] font-bold transition-all active:scale-95 shadow-md cursor-pointer ${isSyncing ? 'opacity-50' : ''}`}
            title="強制同步委託與持倉（包含外部平台送出的單）"
          >
            SYNC
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => handleCancelOrder('Buy')} className="px-2.5 py-1.5 bg-red-900/40 hover:bg-red-800/60 text-red-400 hover:text-red-300 rounded text-[10px] font-bold border border-red-800/50 transition-all active:scale-95 cursor-pointer">全刪買</button>
          <button onClick={handleFlatten} className="px-3 py-1.5 bg-amber-900/40 hover:bg-amber-800/60 text-amber-400 hover:text-amber-300 rounded text-[10px] font-black border border-amber-700/50 transition-all active:scale-95 cursor-pointer">平倉</button>
          <button onClick={handleReverse} className="px-3 py-1.5 bg-purple-900/40 hover:bg-purple-800/60 text-purple-400 hover:text-purple-300 rounded text-[10px] font-black border border-purple-700/50 transition-all active:scale-95 cursor-pointer">反手</button>
          <button onClick={() => handleCancelOrder('Sell')} className="px-2.5 py-1.5 bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-400 hover:text-emerald-300 rounded text-[10px] font-bold border border-emerald-800/50 transition-all active:scale-95 cursor-pointer">全刪賣</button>
        </div>
      </div>
    </div>
  );
};

// handler props 皆為 useCallback，memo 可擋掉 tick 造成的重繪
export const DOMFooter = React.memo(DOMFooterInner);
DOMFooter.displayName = 'DOMFooter';
