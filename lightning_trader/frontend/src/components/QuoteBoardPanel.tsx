/**
 * QuoteBoardPanel — 全寬報價看板（Sprint 34）
 *
 * 與窄欄的 WatchlistPanel 並存、共用同一份自選清單（SettingsContext.watchlist,
 * 跨裝置同步）。差別在於這裡是寬表格矩陣:成交 / 漲跌 / 漲跌% / 高 / 低 / 總量 /
 * 委買 / 委賣,且欄位可點擊排序。資料源是 TradingContext.watchlistQuotes（MiniQuote）。
 *
 * 互動:
 *  - 點欄位標題 → 切換排序欄位 / 升降冪（純函式 sortQuotes）
 *  - 點資料列 → setTargetSymbol + subscribe，主圖跟著切換
 *  - 上方輸入框 / SymbolPicker → 加入自選（沿用 WatchlistPanel 的 updateSetting 機制）
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { SymbolPicker } from './SymbolPicker';
import PanelTitle from './ui/PanelTitle';
import { formatPrice } from '../utils/instrument';
import { UP_COLOR, DOWN_COLOR, FLAT_COLOR } from '../utils/priceColor';
import { computeChange, isStaleQuote, sortQuotes, type QuoteSortKey, type SortDir } from '../utils/quoteBoard';
import { apiClient } from '../api/client';

const MAX_ITEMS = 20;
const STALE_MS = 10_000;

interface Column {
  key: QuoteSortKey | null;   // null = 不可排序欄
  label: string;
  align: 'left' | 'right';
}

const COLUMNS: Column[] = [
  { key: 'symbol', label: '代號', align: 'left' },
  { key: 'price', label: '成交', align: 'right' },
  { key: 'changePct', label: '漲跌', align: 'right' },
  { key: 'changePct', label: '幅%', align: 'right' },
  { key: null, label: '最高', align: 'right' },
  { key: null, label: '最低', align: 'right' },
  { key: 'volume', label: '總量', align: 'right' },
  { key: null, label: '委買', align: 'right' },
  { key: null, label: '委賣', align: 'right' },
];

const QuoteBoardPanel: React.FC = () => {
  const { targetSymbol, subscribe, watchlistQuotes, watchSymbols } = useTradingContext();
  const { settings, updateSetting } = useSettings();
  const list = settings.watchlist;

  // 確保獨立彈出視窗（/panel/quoteboard）也會訂閱自選清單；在主儀表板與
  // WatchlistPanel 的呼叫是等冪聯集，不會互相覆蓋或重複送出。
  useEffect(() => {
    watchSymbols(list);
  }, [list, watchSymbols]);

  const [sortKey, setSortKey] = useState<QuoteSortKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // 每秒更新一次 now,讓 stale 判定隨時間自然更新（Date.now 只在 interval 裡呼叫,
  // 避免在 render 期間呼叫 impure 函式、也不在 effect 裡同步 setState）。
  // 初始 0 → 真實報價的 updatedAt 遠大於 0,不會誤判 stale;首個 interval(1s 內)補上真值。
  const [now, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 商品中文名快取（與 WatchlistPanel 同樣打 /symbols/search）
  const [namesCache, setNamesCache] = useState<Record<string, string>>({});
  const fetchingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const missing = list.filter((sym) => !namesCache[sym] && !fetchingRef.current.has(sym));
    if (missing.length === 0) return;
    missing.forEach((sym) => fetchingRef.current.add(sym));
    missing.forEach((sym) => {
      apiClient.get('/symbols/search', { params: { q: sym, limit: 5 } })
        .then((res) => {
          const hits = res.data as Array<{ symbol: string; name: string }>;
          const hit = hits.find((h) => h.symbol === sym) || hits[0];
          if (hit && hit.name) setNamesCache((prev) => ({ ...prev, [sym]: hit.name }));
        })
        .catch(() => {});
    });
  }, [list, namesCache]);

  const addSymbol = (sym: string) => {
    const s = (sym || '').trim().toUpperCase();
    if (!s) return;
    if (list.includes(s)) return;
    updateSetting({ watchlist: [...list, s].slice(0, MAX_ITEMS) });
  };

  const handleSort = (key: QuoteSortKey | null) => {
    if (!key) return;
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'symbol' ? 'asc' : 'desc');
    }
  };

  const rows = useMemo(() => {
    const base = list.map((sym) => {
      const q = watchlistQuotes[sym];
      return {
        symbol: sym,
        price: q?.price ?? 0,
        reference: q?.reference ?? 0,
        high: q?.high ?? 0,
        low: q?.low ?? 0,
        volume: q?.volume ?? 0,
        bidPrice: q?.bidPrice ?? 0,
        askPrice: q?.askPrice ?? 0,
        updatedAt: q?.updatedAt ?? 0,
      };
    });
    return sortQuotes(base, sortKey, sortDir);
  }, [list, watchlistQuotes, sortKey, sortDir]);

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <PanelTitle>報價看板 ({list.length})</PanelTitle>
        <SymbolPicker onSelect={addSymbol} />
      </div>
      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-[#1C2331] text-slate-500 z-10">
            <tr>
              {COLUMNS.map((col, i) => {
                const active = col.key && col.key === sortKey;
                return (
                  <th
                    key={i}
                    onClick={() => handleSort(col.key)}
                    className={`px-2 py-1.5 font-medium select-none ${col.align === 'right' ? 'text-right' : 'text-left'} ${col.key ? 'cursor-pointer hover:text-slate-300' : ''} ${active ? 'text-[#D4AF37]' : ''}`}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {col.label}
                      {col.key && (active
                        ? (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)
                        : <ArrowUpDown className="w-3 h-3 opacity-30" />)}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr><td colSpan={COLUMNS.length} className="py-8 text-center text-slate-600 italic">尚未加入自選</td></tr>
            ) : rows.map((r) => {
              const isCurrent = r.symbol === targetSymbol;
              const ch = computeChange(r.price, r.reference);
              const stale = isStaleQuote(r.updatedAt, now, STALE_MS);
              const up = ch ? ch.change > 0 : false;
              const down = ch ? ch.change < 0 : false;
              const dirColor = up ? UP_COLOR : down ? DOWN_COLOR : FLAT_COLOR;
              return (
                <tr
                  key={r.symbol}
                  onClick={() => subscribe(r.symbol)}
                  className={`group hover:bg-slate-700/40 cursor-pointer ${isCurrent ? 'bg-[#D4AF37]/10 border-l-2 border-[#D4AF37]' : ''} ${stale ? 'opacity-45' : ''}`}
                  title={`點擊切換到 ${r.symbol}`}
                >
                  <td className="px-2 py-1 text-left">
                    <div className="flex flex-col min-w-0">
                      <span className="font-mono font-bold text-slate-200">{r.symbol}</span>
                      {namesCache[r.symbol] && (
                        <span className="text-[9px] text-slate-400 max-w-[88px] truncate" title={namesCache[r.symbol]}>
                          {namesCache[r.symbol]}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${dirColor}`}>
                    {r.price > 0 ? formatPrice(r.price, r.symbol) : '—'}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${dirColor}`}>
                    {ch ? `${ch.change > 0 ? '+' : ''}${ch.change.toFixed(2)}` : '—'}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${dirColor}`}>
                    {ch ? `${ch.pct > 0 ? '+' : ''}${ch.pct.toFixed(2)}%` : '—'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-slate-400">
                    {r.high > 0 ? formatPrice(r.high, r.symbol) : '—'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-slate-400">
                    {r.low > 0 ? formatPrice(r.low, r.symbol) : '—'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-slate-400">
                    {r.volume > 0 ? r.volume.toLocaleString() : '—'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-emerald-300/70">
                    {r.bidPrice > 0 ? formatPrice(r.bidPrice, r.symbol) : '—'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-red-300/70">
                    {r.askPrice > 0 ? formatPrice(r.askPrice, r.symbol) : '—'}
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

export default QuoteBoardPanel;
