/**
 * MultiChartPanel — 多圖看盤（Sprint 34）
 *
 * 1 / 2 / 4 宮格,每格內嵌一個 <ChartPanel symbol compact />,各自獨立商品與週期。
 * 每格上方有小代號輸入框（Enter 確認）。格子的 symbol 清單與宮格模式存 localStorage。
 *
 * 訂閱:把所有格子的 symbol 透過 TradingContext.setAuxWatch 併入背景訂閱
 * （setAuxWatch 與自選清單取聯集,不會洗掉 WatchlistPanel 的訂閱）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Square, Grid2x2 } from 'lucide-react';
import { useTradingContext } from '../contexts/TradingContext';
import ChartPanel from './ChartPanel';

type GridMode = 1 | 2 | 4;
const STORAGE_KEY = 'lighTrade_mchart';

interface MChartState {
  mode: GridMode;
  symbols: string[];   // 長度固定 4,空字串代表該格未設定
}

function loadState(fallbackSymbol: string): MChartState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MChartState>;
      const mode = ([1, 2, 4] as GridMode[]).includes(parsed.mode as GridMode) ? (parsed.mode as GridMode) : 1;
      const syms = Array.isArray(parsed.symbols) ? parsed.symbols.slice(0, 4) : [];
      while (syms.length < 4) syms.push('');
      return { mode, symbols: syms };
    }
  } catch { /* noop */ }
  // 首次:第一格跟 targetSymbol,其餘空白
  return { mode: 1, symbols: [fallbackSymbol || '', '', '', ''] };
}

const MultiChartPanel: React.FC = () => {
  const { targetSymbol, setAuxWatch } = useTradingContext();
  const [state, setState] = useState<MChartState>(() => loadState(targetSymbol));
  // 每格的輸入暫存（未按 Enter 前不套用）
  const [drafts, setDrafts] = useState<string[]>(() => state.symbols.slice());

  // 持久化
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* noop */ }
  }, [state]);

  // 把可見格子的 symbol 餵給背景訂閱
  const visibleCount = state.mode;
  const activeSymbols = useMemo(
    () => state.symbols.slice(0, visibleCount).map((s) => s.trim().toUpperCase()).filter(Boolean),
    [state.symbols, visibleCount],
  );
  // 用 join 當依賴,避免每 render 都觸發
  const activeKey = activeSymbols.join(',');
  const setAuxWatchRef = useRef(setAuxWatch);
  setAuxWatchRef.current = setAuxWatch;
  useEffect(() => {
    setAuxWatchRef.current(activeSymbols);
    // 卸載時清掉輔助訂閱,不殘留
    return () => setAuxWatchRef.current([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const setMode = (mode: GridMode) => setState((s) => ({ ...s, mode }));

  const commitSymbol = (idx: number) => {
    const val = (drafts[idx] || '').trim().toUpperCase();
    setState((s) => {
      const symbols = s.symbols.slice();
      symbols[idx] = val;
      return { ...s, symbols };
    });
  };

  const gridClass = state.mode === 1
    ? 'grid-cols-1 grid-rows-1'
    : state.mode === 2
      ? 'grid-cols-2 grid-rows-1'
      : 'grid-cols-2 grid-rows-2';

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <span className="w-1 h-3.5 bg-amber-500 rounded-full"></span>
          多圖看盤
        </h3>
        <div className="flex items-center gap-1">
          {([
            { m: 1 as GridMode, Icon: Square, title: '單圖' },
            { m: 2 as GridMode, Icon: LayoutGrid, title: '雙圖' },
            { m: 4 as GridMode, Icon: Grid2x2, title: '四圖' },
          ]).map(({ m, Icon, title }) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              title={title}
              className={`p-1 rounded border transition-colors ${
                state.mode === m
                  ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]'
                  : 'bg-slate-900 text-slate-500 border-slate-700 hover:text-slate-300'
              }`}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>
      <div className={`flex-1 min-h-0 grid ${gridClass} gap-1 p-1`}>
        {Array.from({ length: visibleCount }).map((_, idx) => {
          const sym = state.symbols[idx]?.trim().toUpperCase() || '';
          return (
            <div key={idx} className="flex flex-col min-h-0 min-w-0 border border-slate-700/50 rounded overflow-hidden">
              <div className="flex items-center gap-1 px-1.5 py-1 bg-slate-900/60 border-b border-slate-700/40">
                <input
                  value={drafts[idx] ?? ''}
                  onChange={(e) => setDrafts((d) => { const n = d.slice(); n[idx] = e.target.value; return n; })}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitSymbol(idx); }}
                  onBlur={() => commitSymbol(idx)}
                  placeholder="輸入代號 ↵"
                  className="w-24 bg-slate-800 text-slate-200 text-[11px] font-mono px-1.5 py-0.5 rounded border border-slate-700 focus:border-[#D4AF37] outline-none placeholder:text-slate-600"
                />
                <span className="text-[10px] text-slate-500 font-mono truncate">{sym}</span>
              </div>
              <div className="flex-1 min-h-0">
                {sym ? (
                  <ChartPanel symbol={sym} compact />
                ) : (
                  <div className="h-full flex items-center justify-center text-slate-600 text-xs italic">
                    輸入代號以顯示 K 線
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MultiChartPanel;
