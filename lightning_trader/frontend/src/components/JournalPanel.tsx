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
import { History, RefreshCw } from 'lucide-react';
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
};

type Stats = {
  fills: number;
  first_ts: number | null;
  last_ts: number | null;
  buy_lots: number;
  sell_lots: number;
  top_symbols: Array<{ symbol: string; fills: number }>;
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
        <div className="px-3 py-1.5 border-b border-slate-700/30 bg-slate-900/30 text-[10px] flex flex-wrap gap-x-4 gap-y-1 font-mono tabular-nums">
          <span><span className="text-slate-500">筆數</span> <span className="text-slate-200 font-bold">{stats.fills}</span></span>
          <span><span className="text-slate-500">買進</span> <span className="text-red-400 font-bold">{stats.buy_lots}</span></span>
          <span><span className="text-slate-500">賣出</span> <span className="text-emerald-400 font-bold">{stats.sell_lots}</span></span>
          {stats.top_symbols?.length > 0 && (
            <span>
              <span className="text-slate-500">最多</span>{' '}
              <span className="text-slate-200">{stats.top_symbols.slice(0, 2).map((t) => `${t.symbol}×${t.fills}`).join(' / ')}</span>
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto custom-scrollbar">
        {fills.length === 0 ? (
          <div className="py-10 text-center text-slate-600 italic text-xs">
            {loading ? '載入中…' : '此時段內無成交紀錄'}
          </div>
        ) : (
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#1C2331] text-slate-500">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">時間</th>
                <th className="px-2 py-1.5 text-left font-medium">商品</th>
                <th className="px-2 py-1.5 text-left font-medium">方向</th>
                <th className="px-2 py-1.5 text-right font-medium">成交價</th>
                <th className="px-2 py-1.5 text-right font-medium">口數</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f) => (
                <tr key={f.id} className="hover:bg-slate-700/30 border-b border-slate-800/40">
                  <td className="px-2 py-1 text-slate-400 font-mono">{fmtTime(f.ts)}</td>
                  <td className="px-2 py-1 font-mono font-bold text-slate-200">{f.symbol}</td>
                  <td className={`px-2 py-1 font-bold ${f.action === 'Buy' ? 'text-red-400' : 'text-emerald-400'}`}>
                    {f.action === 'Buy' ? '買' : '賣'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-slate-200">{formatPrice(f.price, f.symbol)}</td>
                  <td className="px-2 py-1 text-right font-mono text-slate-300">{f.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default JournalPanel;
