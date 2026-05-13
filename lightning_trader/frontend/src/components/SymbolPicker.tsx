/**
 * SymbolPicker — 商品搜尋 + 最近商品歷史
 *
 * 行為：
 *  - 使用者在 input 打字 → 300ms debounce 後打 /api/symbols/search
 *  - 下拉顯示符合的商品（symbol / code / name / kind）
 *  - 點擊 / Enter → subscribe(symbol)
 *  - 同時把 symbol 寫入 recent localStorage 列表（最多 8 個）
 *  - 沒打字時：顯示最近商品歷史
 */
import React, { useEffect, useRef, useState } from 'react';
import { Search, Clock } from 'lucide-react';
import { apiClient } from '../api/client';

const RECENT_KEY = 'lightrade_recent_symbols';
const MAX_RECENT = 8;

interface SymbolHit {
  symbol: string;
  code: string;
  name: string;
  kind: 'Stock' | 'Future' | 'Option';
}

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* noop */ }
  return [];
}

function pushRecent(sym: string) {
  const cur = loadRecent().filter((s) => s !== sym);
  cur.unshift(sym);
  localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, MAX_RECENT)));
}

interface Props {
  onSelect: (sym: string) => void;
}

export const SymbolPicker: React.FC<Props> = ({ onSelect }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      apiClient.get('/symbols/search', { params: { q, limit: 12 } })
        .then((res) => setHits(res.data || []))
        .catch(() => setHits([]))
        .finally(() => setLoading(false));
    }, 300);
  }, [q]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handlePick = (sym: string) => {
    pushRecent(sym);
    setRecent(loadRecent());
    setQ('');
    setHits([]);
    setOpen(false);
    onSelect(sym);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && hits.length > 0) {
      e.preventDefault();
      handlePick(hits[0].symbol);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const showHistory = !q.trim() && recent.length > 0;
  const showHits = hits.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1 bg-slate-900 rounded border border-slate-700 px-2 py-1 focus-within:border-[#D4AF37] transition-all w-44">
        <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={handleKeyDown}
          placeholder="搜尋商品..."
          className="bg-transparent text-slate-200 outline-none font-mono w-full text-xs placeholder-slate-600"
        />
        {loading && <span className="text-[9px] text-slate-500">...</span>}
      </div>

      {open && (showHistory || showHits) && (
        <div className="absolute top-full mt-1 right-0 z-50 w-72 bg-[#1C2331] border border-slate-700 rounded shadow-2xl max-h-80 overflow-auto custom-scrollbar">
          {showHistory && (
            <>
              <div className="px-3 py-1.5 text-[9px] uppercase tracking-widest text-slate-500 font-bold border-b border-slate-800 flex items-center gap-1">
                <Clock className="w-3 h-3" /> 最近
              </div>
              {recent.map((s) => (
                <button
                  key={s}
                  onClick={() => handlePick(s)}
                  className="w-full px-3 py-1.5 text-left text-sm font-mono text-slate-200 hover:bg-slate-800 transition-colors flex justify-between"
                >
                  <span>{s}</span>
                </button>
              ))}
            </>
          )}
          {showHits && (
            <>
              <div className="px-3 py-1.5 text-[9px] uppercase tracking-widest text-slate-500 font-bold border-b border-slate-800">搜尋結果</div>
              {hits.map((h) => (
                <button
                  key={`${h.kind}-${h.code}-${h.symbol}`}
                  onClick={() => handlePick(h.symbol)}
                  className="w-full px-3 py-1.5 text-left text-xs hover:bg-slate-800 transition-colors flex items-center justify-between border-b border-slate-800/50 last:border-b-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-bold text-[#D4AF37] shrink-0">{h.symbol}</span>
                    <span className="text-slate-300 truncate">{h.name}</span>
                  </div>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold shrink-0 ml-2 ${
                    h.kind === 'Stock'  ? 'bg-blue-500/20 text-blue-300' :
                    h.kind === 'Future' ? 'bg-amber-500/20 text-amber-300' :
                                          'bg-purple-500/20 text-purple-300'
                  }`}>{h.kind === 'Stock' ? '證' : h.kind === 'Future' ? '期' : '權'}</span>
                </button>
              ))}
            </>
          )}
          {!showHistory && !showHits && (
            <div className="px-3 py-3 text-xs text-slate-500 text-center">無結果</div>
          )}
        </div>
      )}
    </div>
  );
};
