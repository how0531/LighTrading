/**
 * StatsPanel — 交易績效統計面板
 *
 * 顯示 7 個關鍵指標：
 *   - Win rate (勝率)
 *   - Avg win / Avg loss
 *   - Profit factor
 *   - Max drawdown + duration
 *   - Sharpe (per trade)
 *   - Biggest win / loss
 *   - Expectancy
 *
 * 資料源：GET /api/journal/stats_advanced（FIFO 已配對的 deltas）
 */
import React, { useEffect, useState } from 'react';
import { Award, RefreshCw } from 'lucide-react';
import { apiClient } from '../api/client';
import { UP_COLOR, DOWN_COLOR } from '../utils/priceColor';

type Stats = {
  count_total: number;
  count_closing: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_win: number;
  avg_loss: number;
  profit_factor: number | null;
  biggest_win: number;
  biggest_loss: number;
  max_drawdown: number;
  max_drawdown_duration_s: number;
  sharpe_per_trade: number | null;
  expectancy: number;
  final_realized_pnl: number;
  mean_interval_s: number | null;
  median_interval_s: number | null;
  shortest_interval_s: number | null;
  peak_fills_per_minute: number;
};

const RANGES = [
  { id: 'today', label: '今日',  hours: 24 },
  { id: 'week',  label: '7 天',  hours: 24 * 7 },
  { id: 'month', label: '30 天', hours: 24 * 30 },
  { id: 'all',   label: '全部',  hours: 0 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString();
}
function fmtPct(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
function fmtInterval(s: number | null): string {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

const Tile: React.FC<{ label: string; value: string; sub?: string; tone?: 'pos' | 'neg' | 'neu' }> = ({ label, value, sub, tone = 'neu' }) => {
  const color =
    tone === 'pos' ? UP_COLOR
    : tone === 'neg' ? DOWN_COLOR
    : 'text-slate-200';
  return (
    <div className="bg-slate-900/50 border border-slate-700/50 rounded p-2 min-w-0">
      <div className="text-[9px] text-slate-500 uppercase tracking-wider truncate">{label}</div>
      <div className={`text-base font-mono font-black tabular-nums truncate ${color}`}>{value}</div>
      {sub && <div className="text-[9px] text-slate-500 truncate">{sub}</div>}
    </div>
  );
};

const StatsPanel: React.FC = () => {
  const [range, setRange] = useState<RangeId>('week');
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const meta = RANGES.find((r) => r.id === range)!;
      const params: Record<string, number> = {};
      if (meta.hours > 0) params.from_ts = Date.now() - meta.hours * 3600 * 1000;
      const res = await apiClient.get<Stats>('/journal/stats_advanced', { params });
      setStats(res.data);
    } catch {
      setStats(null);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <Award className="w-3.5 h-3.5 text-amber-400" />
          交易績效
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
            onClick={fetchData}
            disabled={loading}
            className="ml-1 p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto custom-scrollbar p-2">
        {!stats || stats.count_closing === 0 ? (
          <div className="py-10 text-center text-slate-600 italic text-xs">
            {loading ? '計算中…' : '此時段無已配對交易'}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            <Tile
              label="累積已實現 PnL"
              value={`${stats.final_realized_pnl > 0 ? '+' : ''}${fmt(stats.final_realized_pnl)}`}
              tone={stats.final_realized_pnl > 0 ? 'pos' : stats.final_realized_pnl < 0 ? 'neg' : 'neu'}
            />
            <Tile
              label="勝率"
              value={fmtPct(stats.win_rate)}
              sub={`${stats.wins}W / ${stats.losses}L`}
            />
            <Tile
              label="獲利因子 PF"
              value={stats.profit_factor !== null ? stats.profit_factor.toFixed(2) : '—'}
              sub="總賺 / 總賠"
              tone={stats.profit_factor !== null && stats.profit_factor >= 1 ? 'pos' : 'neg'}
            />
            <Tile
              label="期望值 / 筆"
              value={`${stats.expectancy > 0 ? '+' : ''}${fmt(stats.expectancy)}`}
              tone={stats.expectancy > 0 ? 'pos' : stats.expectancy < 0 ? 'neg' : 'neu'}
            />
            <Tile label="平均賺" value={`+${fmt(stats.avg_win)}`} tone="pos" />
            <Tile label="平均賠" value={`-${fmt(stats.avg_loss)}`} tone="neg" />
            <Tile label="最大單筆" value={`+${fmt(stats.biggest_win)}`} tone="pos" />
            <Tile label="最大跌幅" value={`-${fmt(stats.biggest_loss)}`} tone="neg" />
            <Tile
              label="最大回撤 MDD"
              value={`-${fmt(stats.max_drawdown)}`}
              sub={stats.max_drawdown_duration_s > 0 ? `持續 ${fmtDuration(stats.max_drawdown_duration_s)}` : undefined}
              tone={stats.max_drawdown > 0 ? 'neg' : 'neu'}
            />
            <Tile
              label="Sharpe / 筆"
              value={stats.sharpe_per_trade !== null ? stats.sharpe_per_trade.toFixed(2) : '—'}
              sub="μ / σ (per trade)"
            />
            <Tile
              label="總成交數"
              value={fmt(stats.count_total)}
              sub={`${stats.count_closing} 平倉`}
            />
            <Tile
              label="平均間隔"
              value={fmtInterval(stats.mean_interval_s)}
              sub={stats.median_interval_s !== null ? `中位 ${fmtInterval(stats.median_interval_s)}` : undefined}
            />
            <Tile
              label="最快兩單"
              value={fmtInterval(stats.shortest_interval_s)}
              sub="連續成交間隔"
            />
            <Tile
              label="尖峰 / 分"
              value={fmt(stats.peak_fills_per_minute)}
              sub="60s 視窗最大下單"
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default StatsPanel;
