/**
 * WatchlistPanel — 多 symbol 即時報價側欄
 *
 * 功能：
 *   - Sprint 23：從 SettingsContext.watchlist 讀寫 → 自動透過 /api/user_settings
 *     跨裝置同步（不再用 localStorage）
 *   - 舊版 localStorage 鍵 `lightrade_watchlist` 第一次 mount 時自動 migrate
 *   - mount 時把目前 watchlist 透過 TradingContext.watchSymbols 送給後端
 *   - 渲染每個 symbol 的 mini-quote（價、漲跌、漲跌%）
 *   - 點擊 row → 把它變成 target symbol（subscribe）
 *   - 用 SymbolPicker 加入；hover 顯示 X 按鈕移除
 *   - HTML5 native drag 排序
 *
 * 與 ChartPanel 一樣 lazy-loaded。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Eye, GripVertical, ListPlus } from 'lucide-react';
import { useQuotes, useTradingCore, type MiniQuote } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { SymbolPicker } from './SymbolPicker';
import { formatPrice } from '../utils/instrument';
import { apiClient } from '../api/client';

const LEGACY_STORAGE_KEY = 'lightrade_watchlist';   // Sprint 12 用過的 key，搬完後刪
const MAX_ITEMS = 20;

// ── UX 批次 4 Item 9：單列抽成 memo 元件 ─────────────────────
// watchlistQuotes 每 100ms flush 只換「有變動的 symbol」的 MiniQuote 物件參照，
// 其餘列的 props 全部不變 → React.memo 直接跳過，避免整清單跟著任一 tick 重繪。
interface WatchRowProps {
  sym: string;
  q: MiniQuote | undefined;
  isCurrent: boolean;
  name: string | undefined;
  isDragOver: boolean;
  isStaleData: boolean;
  onSelect: (sym: string) => void;
  onRemove: (sym: string) => void;
  onDragStart: (e: React.DragEvent, sym: string) => void;
  onDragOver: (e: React.DragEvent, sym: string) => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent, sym: string) => void;
}

const WatchRow: React.FC<WatchRowProps> = React.memo(({
  sym, q, isCurrent, name, isDragOver, isStaleData,
  onSelect, onRemove, onDragStart, onDragOver, onDragEnd, onDrop,
}) => {
  const price = q?.price ?? 0;
  const ref = q?.reference ?? 0;
  const change = price > 0 && ref > 0 ? price - ref : 0;
  const pct = ref > 0 ? (change / ref) * 100 : 0;
  const up = change > 0, down = change < 0;
  return (
    <tr
      draggable
      onDragStart={(e) => onDragStart(e, sym)}
      onDragOver={(e) => onDragOver(e, sym)}
      onDragEnd={onDragEnd}
      onDrop={(e) => onDrop(e, sym)}
      className={`group hover:bg-slate-700/40 cursor-pointer ${isCurrent ? 'bg-[#D4AF37]/10 border-l-2 border-[#D4AF37]' : ''} ${isDragOver ? 'outline outline-1 outline-[#D4AF37]' : ''}`}
      onClick={() => onSelect(sym)}
      title={`點擊切換到 ${sym} · 拖曳排序`}
    >
      <td className="px-2 py-1 flex items-center gap-1">
        <GripVertical className="w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
        {isCurrent && <Eye className="w-3 h-3 text-[#D4AF37] flex-shrink-0" />}
        <div className="flex flex-col min-w-0">
          <span className="font-mono font-bold text-slate-200">{sym}</span>
          {name && (
            <span className="text-[9px] text-slate-400 font-sans font-normal max-w-[80px] truncate" title={name}>
              {name}
            </span>
          )}
        </div>
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
          onClick={(e) => { e.stopPropagation(); onRemove(sym); }}
          className="opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 text-slate-500 rounded p-0.5 transition-all"
          title="移除"
        >
          <X className="w-3 h-3" />
        </button>
      </td>
    </tr>
  );
});
WatchRow.displayName = 'WatchRow';

/** Sprint 23：從舊 localStorage 撈一次，回傳合法的字串陣列。沒有就回 null。 */
function readLegacyList(): string[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.filter((x) => typeof x === 'string').slice(0, MAX_ITEMS);
  } catch { return null; }
}

const WatchlistPanel: React.FC = () => {
  const { targetSymbol, subscribe, watchSymbols, accountSummary } = useTradingCore();
  const { watchlistQuotes } = useQuotes(); // 自選報價需要 tick 資料
  const { settings, updateSetting } = useSettings();
  const list = settings.watchlist;
  const setList = (next: string[] | ((prev: string[]) => string[])) => {
    const resolved = typeof next === 'function' ? (next as (p: string[]) => string[])(list) : next;
    updateSetting({ watchlist: resolved.slice(0, MAX_ITEMS) });
  };

  const [namesCache, setNamesCache] = useState<Record<string, string>>({});
  const fetchingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const missing = list.filter(sym => !namesCache[sym] && !fetchingRef.current.has(sym));
    if (missing.length === 0) return;

    missing.forEach(sym => fetchingRef.current.add(sym));

    missing.forEach(sym => {
      apiClient.get('/symbols/search', { params: { q: sym, limit: 5 } })
        .then(res => {
          const hits = res.data;
          const hit = hits.find((h: { symbol: string; name?: string }) => h.symbol === sym) || hits[0];
          if (hit && hit.name) {
            setNamesCache(prev => ({ ...prev, [sym]: hit.name }));
          }
        })
        .catch(() => {});
    });
  }, [list, namesCache]);

  // Sprint 23：第一次 mount 時把舊 localStorage 資料搬進 settings.watchlist
  // 條件：legacy 有資料，且 settings.watchlist 還是 DEFAULT（避免覆蓋使用者已調整的清單）
  useEffect(() => {
    const legacy = readLegacyList();
    if (!legacy || legacy.length === 0) return;
    const isStillDefault =
      settings.watchlist.length === 5 &&
      settings.watchlist[0] === 'TXFR1' && settings.watchlist[2] === '2330';
    if (isStillDefault) {
      updateSetting({ watchlist: legacy.slice(0, MAX_ITEMS) });
    }
    // 不管 migrate 與否都把 legacy 鍵清掉，避免未來再次誤觸
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sprint 12 R5：算出「持倉但不在 watchlist 內」的 symbol，用來啟用「+ 加入持倉」按鈕
  const missingPositions = useMemo(() => {
    const inList = new Set(list);
    const positions = accountSummary?.positions || [];
    const out: string[] = [];
    for (const p of positions) {
      const s = (p.symbol || '').trim().toUpperCase();
      if (s && !inList.has(s) && !out.includes(s)) out.push(s);
    }
    return out;
  }, [accountSummary?.positions, list]);

  const addAllPositions = () => {
    if (missingPositions.length === 0) return;
    setList((prev) => [...prev, ...missingPositions].slice(0, MAX_ITEMS));
  };
  // Sprint 12 R3：native HTML5 drag-and-drop reorder（不引入 dnd lib，~0 KB cost）
  const dragSrcRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // list 變動：通知 backend 訂閱（settings 端的 persistence 由 SettingsContext 處理）
  useEffect(() => {
    watchSymbols(list);
  }, [list, watchSymbols]);

  const addSymbol = (sym: string) => {
    const s = (sym || '').trim().toUpperCase();
    if (!s) return;
    setList((prev) => (prev.includes(s) ? prev : [...prev, s].slice(0, MAX_ITEMS)));
  };
  // ↓ 傳進 memo WatchRow 的 handler 一律 useCallback（tick flush 重繪時參照不變）
  const removeSymbol = useCallback((sym: string) => {
    updateSetting((prev) => ({ ...prev, watchlist: prev.watchlist.filter((s) => s !== sym) }));
  }, [updateSetting]);

  const handleDragStart = useCallback((e: React.DragEvent, sym: string) => {
    dragSrcRef.current = sym;
    e.dataTransfer.effectAllowed = 'move';
    // 一些瀏覽器 DnD spec 要求 setData 才會 fire drop event
    try { e.dataTransfer.setData('text/plain', sym); } catch { /* ignore */ }
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent, sym: string) => {
    if (!dragSrcRef.current || dragSrcRef.current === sym) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver((cur) => (cur === sym ? cur : sym));
  }, []);
  const handleDragEnd = useCallback(() => {
    dragSrcRef.current = null;
    setDragOver(null);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent, targetSym: string) => {
    e.preventDefault();
    const src = dragSrcRef.current;
    dragSrcRef.current = null;
    setDragOver(null);
    if (!src || src === targetSym) return;
    updateSetting((prev) => {
      const next = prev.watchlist.filter((s) => s !== src);
      const idx = next.indexOf(targetSym);
      if (idx === -1) next.push(src);
      else next.splice(idx, 0, src);
      return { ...prev, watchlist: next.slice(0, MAX_ITEMS) };
    });
  }, [updateSetting]);

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <span className="w-1 h-3.5 bg-amber-500 rounded-full"></span>
          自選 ({list.length})
        </h3>
        <div className="flex items-center gap-1">
          {missingPositions.length > 0 && (
            <button
              onClick={addAllPositions}
              className="flex items-center gap-1 px-2 py-0.5 bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-200 rounded text-[10px] font-bold border border-emerald-700/50 transition-colors cursor-pointer"
              title={`一鍵加入 ${missingPositions.length} 個持倉：${missingPositions.join(', ')}`}
            >
              <ListPlus className="w-3 h-3" /> +持倉 ({missingPositions.length})
            </button>
          )}
          <SymbolPicker onSelect={(s) => addSymbol(s)} />
        </div>
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
              return (
                <WatchRow
                  key={sym}
                  sym={sym}
                  q={q}
                  isCurrent={sym === targetSymbol}
                  name={namesCache[sym]}
                  isDragOver={dragOver === sym}
                  isStaleData={!q || (Date.now() - (q.updatedAt || 0) > 10_000)}
                  onSelect={subscribe}
                  onRemove={removeSymbol}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragEnd={handleDragEnd}
                  onDrop={handleDrop}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default WatchlistPanel;
