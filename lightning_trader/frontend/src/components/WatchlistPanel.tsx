/**
 * WatchlistPanel — 多 symbol 即時報價側欄
 *
 * 功能：
 *   - localStorage 持久化清單（key: `lightrade_watchlist`）
 *   - mount 時把目前 watchlist 透過 TradingContext.watchSymbols 送給後端
 *   - 渲染每個 symbol 的 mini-quote（價、漲跌、漲跌%）
 *   - 點擊 row → 把它變成 target symbol（subscribe）
 *   - 用 SymbolPicker 加入；hover 顯示 X 按鈕移除
 *
 * 與 ChartPanel 一樣 lazy-loaded。
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, Eye, GripVertical } from 'lucide-react';
import { useTradingContext } from '../contexts/TradingContext';
import { SymbolPicker } from './SymbolPicker';
import { formatPrice } from '../utils/instrument';

const STORAGE_KEY = 'lightrade_watchlist';
const DEFAULT_LIST = ['TXFR1', 'MXFR1', '2330', '2454', '0050'];
const MAX_ITEMS = 20;

function loadList(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string').slice(0, MAX_ITEMS);
    }
  } catch { /* noop */ }
  return DEFAULT_LIST;
}
function saveList(list: string[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ITEMS))); } catch { /* noop */ }
}

const WatchlistPanel: React.FC = () => {
  const { targetSymbol, subscribe, watchlistQuotes, watchSymbols } = useTradingContext();
  const [list, setList] = useState<string[]>(() => loadList());
  // Sprint 12 R3：native HTML5 drag-and-drop reorder（不引入 dnd lib，~0 KB cost）
  const dragSrcRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // mount 與 list 變動：通知 context 訂閱
  useEffect(() => {
    watchSymbols(list);
    saveList(list);
  }, [list, watchSymbols]);

  const addSymbol = (sym: string) => {
    const s = (sym || '').trim().toUpperCase();
    if (!s) return;
    setList((prev) => (prev.includes(s) ? prev : [...prev, s].slice(0, MAX_ITEMS)));
  };
  const removeSymbol = (sym: string) => {
    setList((prev) => prev.filter((s) => s !== sym));
  };

  const handleDragStart = (e: React.DragEvent, sym: string) => {
    dragSrcRef.current = sym;
    e.dataTransfer.effectAllowed = 'move';
    // 一些瀏覽器 DnD spec 要求 setData 才會 fire drop event
    try { e.dataTransfer.setData('text/plain', sym); } catch { /* ignore */ }
  };
  const handleDragOver = (e: React.DragEvent, sym: string) => {
    if (!dragSrcRef.current || dragSrcRef.current === sym) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOver !== sym) setDragOver(sym);
  };
  const handleDragEnd = () => {
    dragSrcRef.current = null;
    setDragOver(null);
  };
  const handleDrop = (e: React.DragEvent, targetSym: string) => {
    e.preventDefault();
    const src = dragSrcRef.current;
    dragSrcRef.current = null;
    setDragOver(null);
    if (!src || src === targetSym) return;
    setList((prev) => {
      const next = prev.filter((s) => s !== src);
      const idx = next.indexOf(targetSym);
      if (idx === -1) return [...next, src];
      next.splice(idx, 0, src);
      return next;
    });
  };

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <span className="w-1 h-3.5 bg-amber-500 rounded-full"></span>
          自選 ({list.length})
        </h3>
        <SymbolPicker onSelect={(s) => addSymbol(s)} />
      </div>
      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-[#1C2331] text-slate-500 z-10">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">代碼</th>
              <th className="px-2 py-1.5 text-right font-medium">最新價</th>
              <th className="px-2 py-1.5 text-right font-medium">漲跌</th>
              <th className="px-2 py-1.5 text-right font-medium">%</th>
              <th className="px-2 py-1.5 w-6"></th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr><td colSpan={5} className="py-8 text-center text-slate-600 italic">尚未加入自選</td></tr>
            ) : list.map((sym) => {
              const q = watchlistQuotes[sym];
              const isCurrent = sym === targetSymbol;
              const price = q?.price ?? 0;
              const ref = q?.reference ?? 0;
              const change = price > 0 && ref > 0 ? price - ref : 0;
              const pct = ref > 0 ? (change / ref) * 100 : 0;
              const isStaleData = !q || (Date.now() - (q.updatedAt || 0) > 10_000);
              const up = change > 0, down = change < 0;
              return (
                <tr
                  key={sym}
                  draggable
                  onDragStart={(e) => handleDragStart(e, sym)}
                  onDragOver={(e) => handleDragOver(e, sym)}
                  onDragEnd={handleDragEnd}
                  onDrop={(e) => handleDrop(e, sym)}
                  className={`group hover:bg-slate-700/40 cursor-pointer ${isCurrent ? 'bg-[#D4AF37]/10 border-l-2 border-[#D4AF37]' : ''} ${dragOver === sym ? 'outline outline-1 outline-[#D4AF37]' : ''}`}
                  onClick={() => subscribe(sym)}
                  title={`點擊切換到 ${sym} · 拖曳排序`}
                >
                  <td className="px-2 py-1 font-mono font-bold text-slate-200 flex items-center gap-1">
                    <GripVertical className="w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                    {isCurrent && <Eye className="w-3 h-3 text-[#D4AF37]" />}
                    {sym}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${isStaleData ? 'text-slate-600' : up ? 'text-red-400' : down ? 'text-emerald-400' : 'text-slate-300'}`}>
                    {price > 0 ? formatPrice(price, sym) : '—'}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${up ? 'text-red-400' : down ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {price > 0 && ref > 0 ? `${change > 0 ? '+' : ''}${change.toFixed(2)}` : '—'}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${up ? 'text-red-400' : down ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {price > 0 && ref > 0 ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
                  </td>
                  <td className="px-1 py-1 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); removeSymbol(sym); }}
                      className="opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 text-slate-500 rounded p-0.5 transition-all"
                      title="移除"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default WatchlistPanel;
