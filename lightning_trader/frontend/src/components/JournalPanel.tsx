/**
 * JournalPanel — 歷史成交日誌（從 SQLite journal）
 *
 * 預設拉最近 N 筆，點 refresh 重抓。三個快速時段：今日 / 7 天 / 全部。
 *
 * 與 Panel_OrderHistory / Panel_TradeHistory 區分：
 *   - 那些只看「當日 list_trades」，靠 backend 在線 + Shioaji 連線
 *   - JournalPanel 看的是「歷史 fills」，已落地 SQLite，跨重啟、跨登入都在
 */
import React, { useEffect, useState } from 'react';
import { History, RefreshCw, Upload, ChevronRight, ChevronDown, Tag as TagIcon } from 'lucide-react';
import { useRef } from 'react';
import { apiClient, normalizeApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { formatPrice } from '../utils/instrument';

type Fill = {
  id: string;
  ts: number;       // unix ms
  symbol: string;
  action: 'Buy' | 'Sell';
  price: number;
  qty: number;
  order_id: string;
  tag: string | null;
  notes: string | null;
};

type Stats = {
  fills: number;
  first_ts: number | null;
  last_ts: number | null;
  buy_lots: number;
  sell_lots: number;
  top_symbols: Array<{ symbol: string; fills: number }>;
  by_tag: Array<{ tag: string; fills: number }>;
};

const RANGES = [
  { id: 'today', label: '今日',  hours: 24 },
  { id: 'week',  label: '7 天',  hours: 24 * 7 },
  { id: 'all',   label: '全部',  hours: 0 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  return `${date} ${hh}:${mm}:${ss}`;
}

const JournalPanel: React.FC = () => {
  const { toast } = useToast();
  const [range, setRange] = useState<RangeId>('today');
  const [fills, setFills] = useState<Fill[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  // Sprint 32：紀律標記 — 展開列編輯 tag / notes
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draftTag, setDraftTag] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [tagFilter, setTagFilter] = useState<string>('');

  const openEditor = (f: Fill) => {
    if (expanded === f.id) { setExpanded(null); return; }
    setExpanded(f.id);
    setDraftTag(f.tag || '');
    setDraftNotes(f.notes || '');
  };

  const saveMeta = async (fillId: string) => {
    setSavingMeta(true);
    try {
      await apiClient.post(`/journal/fill/${encodeURIComponent(fillId)}/meta`, {
        tag: draftTag.trim(),
        notes: draftNotes.trim(),
      });
      setFills((prev) => prev.map((x) =>
        x.id === fillId ? { ...x, tag: draftTag.trim(), notes: draftNotes.trim() } : x));
      setExpanded(null);
      toast.success('已更新標記');
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '標記失敗');
    } finally {
      setSavingMeta(false);
    }
  };

  const fetchAll = async () => {
    setLoading(true);
    try {
      const meta = RANGES.find((r) => r.id === range)!;
      const params: Record<string, number> = { limit: 500 };
      if (meta.hours > 0) {
        params.from_ts = Date.now() - meta.hours * 3600 * 1000;
      }
      const [f, s] = await Promise.all([
        apiClient.get<Fill[]>('/journal/fills', { params }),
        apiClient.get<Stats>('/journal/stats', { params }),
      ]);
      setFills(f.data || []);
      setStats(s.data || null);
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '取得日誌失敗');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sprint 24：CSV import
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const form = new FormData();
    form.append('file', f);
    try {
      const res = await apiClient.post('/journal/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const r = res.data as { total_rows: number; accepted: number; skipped: number; errors: string[] };
      toast.success(`匯入完成：${r.accepted} 筆寫入 / ${r.skipped} 略過 / ${r.errors.length} 錯誤`);
      if (r.errors.length > 0) {
        toast.warn(`前幾筆錯誤：${r.errors.slice(0, 3).join(' | ')}`);
      }
      fetchAll();
    } catch (err) {
      const ne = normalizeApiError(err);
      toast.error(ne.user_msg || '匯入失敗');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <History className="w-3.5 h-3.5 text-amber-400" />
          交易日誌
        </h3>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`px-2 py-0.5 text-[10px] font-bold rounded border transition-colors ${
                range === r.id
                  ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]'
                  : 'bg-slate-900 text-slate-500 border-slate-700 hover:text-slate-300'
              }`}
            >
              {r.label}
            </button>
          ))}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="ml-1 p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-slate-200 transition-colors"
            title="從 CSV 匯入歷史成交（columns: time, symbol, action, price, qty）"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleImport}
            className="hidden"
          />
          <button
            onClick={fetchAll}
            disabled={loading}
            className="ml-1 p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
            title="重新整理"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {stats && stats.fills > 0 && (
        <div className="px-3 py-1.5 border-b border-slate-700/30 bg-slate-900/30 text-[10px] flex flex-wrap gap-x-4 gap-y-1 font-mono tabular-nums items-center">
          <span><span className="text-slate-500">筆數</span> <span className="text-slate-200 font-bold">{stats.fills}</span></span>
          <span><span className="text-slate-500">買進</span> <span className="text-red-400 font-bold">{stats.buy_lots}</span></span>
          <span><span className="text-slate-500">賣出</span> <span className="text-emerald-400 font-bold">{stats.sell_lots}</span></span>
          {stats.top_symbols?.length > 0 && (
            <span>
              <span className="text-slate-500">最多</span>{' '}
              <span className="text-slate-200">{stats.top_symbols.slice(0, 2).map((t) => `${t.symbol}×${t.fills}`).join(' / ')}</span>
            </span>
          )}
          {stats.by_tag?.filter((t) => t.tag !== '(未標記)').length > 0 && (
            <span className="flex items-center gap-1 flex-wrap">
              <TagIcon className="w-2.5 h-2.5 text-slate-500" />
              {stats.by_tag.map((t) => (
                <button
                  key={t.tag}
                  onClick={() => setTagFilter(tagFilter === t.tag ? '' : t.tag)}
                  className={`px-1.5 py-0.5 rounded border text-[9px] transition-colors ${
                    tagFilter === t.tag
                      ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]'
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
                  }`}
                >
                  {t.tag}×{t.fills}
                </button>
              ))}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto custom-scrollbar">
        {(() => {
          const shown = tagFilter
            ? fills.filter((f) => tagFilter === '(未標記)' ? !f.tag : f.tag === tagFilter)
            : fills;
          if (shown.length === 0) {
            return (
              <div className="py-10 text-center text-slate-600 italic text-xs">
                {loading ? '載入中…' : tagFilter ? `「${tagFilter}」無成交紀錄` : '此時段內無成交紀錄'}
              </div>
            );
          }
          return (
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#1C2331] text-slate-500">
              <tr>
                <th className="px-1 py-1.5 w-5"></th>
                <th className="px-2 py-1.5 text-left font-medium">時間</th>
                <th className="px-2 py-1.5 text-left font-medium">商品</th>
                <th className="px-2 py-1.5 text-left font-medium">方向</th>
                <th className="px-2 py-1.5 text-right font-medium">成交價</th>
                <th className="px-2 py-1.5 text-right font-medium">口數</th>
                <th className="px-2 py-1.5 text-left font-medium">標籤</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => {
                const isOpen = expanded === f.id;
                return (
                <React.Fragment key={f.id}>
                <tr className="hover:bg-slate-700/30 border-b border-slate-800/40">
                  <td className="px-1 py-1 text-center cursor-pointer text-slate-500 hover:text-[#D4AF37]"
                      onClick={() => openEditor(f)} title="編輯標籤 / 紀律檢討">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5 inline" /> : <ChevronRight className="w-3.5 h-3.5 inline" />}
                  </td>
                  <td className="px-2 py-1 text-slate-400 font-mono">{fmtTime(f.ts)}</td>
                  <td className="px-2 py-1 font-mono font-bold text-slate-200">{f.symbol}</td>
                  <td className={`px-2 py-1 font-bold ${f.action === 'Buy' ? 'text-red-400' : 'text-emerald-400'}`}>
                    {f.action === 'Buy' ? '買' : '賣'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-slate-200">{formatPrice(f.price, f.symbol)}</td>
                  <td className="px-2 py-1 text-right font-mono text-slate-300">{f.qty}</td>
                  <td className="px-2 py-1 text-left">
                    {f.tag ? (
                      <span className="px-1.5 py-0.5 rounded bg-[#D4AF37]/15 text-[#D4AF37] text-[10px] font-bold">{f.tag}</span>
                    ) : (
                      <span className="text-slate-600 text-[10px]">—</span>
                    )}
                    {f.notes && <span className="ml-1 text-slate-600" title={f.notes}>📝</span>}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7} className="px-3 py-2 bg-slate-900/40">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-10 shrink-0">標籤</label>
                          <input
                            value={draftTag}
                            onChange={(e) => setDraftTag(e.target.value)}
                            maxLength={64}
                            placeholder="如：突破追多 / 逆勢凹單"
                            className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-[#D4AF37]/50"
                          />
                        </div>
                        <div className="flex items-start gap-2">
                          <label className="text-[10px] text-slate-500 w-10 shrink-0 pt-1">檢討</label>
                          <textarea
                            value={draftNotes}
                            onChange={(e) => setDraftNotes(e.target.value)}
                            maxLength={500}
                            rows={2}
                            placeholder="是否照計畫進場？停損守住了嗎？"
                            className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-[#D4AF37]/50 resize-none"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setExpanded(null)}
                            className="px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200 rounded border border-slate-700"
                          >取消</button>
                          <button
                            onClick={() => saveMeta(f.id)}
                            disabled={savingMeta}
                            className="px-3 py-0.5 text-[10px] font-bold text-[#101623] bg-[#D4AF37] hover:bg-[#e0bc4a] rounded disabled:opacity-50"
                          >{savingMeta ? '儲存中…' : '儲存'}</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
          );
        })()}
      </div>
    </div>
  );
};

export default JournalPanel;
