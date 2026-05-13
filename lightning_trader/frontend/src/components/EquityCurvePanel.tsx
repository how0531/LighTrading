/**
 * EquityCurvePanel — 已實現損益累積曲線
 *
 * 用 lightweight-charts 的 LineSeries 畫從 journal 拉到的 FIFO 累積 realized PnL。
 * 每筆 fill 都會推出一個點；買賣方向由 backend FIFO 配對決定何時實現。
 *
 * 預設秀「7 天」；range chip 可切今日 / 30 天 / 全部。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts';
import { TrendingUp, RefreshCw } from 'lucide-react';
import { apiClient } from '../api/client';

type EquityPoint = {
  ts: number;          // unix ms
  symbol: string;
  action: 'Buy' | 'Sell';
  price: number;
  qty: number;
  delta: number;
  realized_pnl: number;
};

const RANGES = [
  { id: 'today', label: '今日',  hours: 24 },
  { id: 'week',  label: '7 天',  hours: 24 * 7 },
  { id: 'month', label: '30 天', hours: 24 * 30 },
  { id: 'all',   label: '全部',  hours: 0 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const COLOR_UP = '#EF4444';     // 紅 = 賺
const COLOR_DOWN = '#10B981';   // 綠 = 虧
const COLOR_FLAT = '#94A3B8';

const EquityCurvePanel: React.FC = () => {
  const [range, setRange] = useState<RangeId>('week');
  const [loading, setLoading] = useState(false);
  const [lastPoint, setLastPoint] = useState<EquityPoint | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const meta = useMemo(() => RANGES.find((r) => r.id === range)!, [range]);

  // 初始化 chart 一次
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#101623' },
        textColor: '#94A3B8',
        fontFamily: 'Barlow, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(62, 78, 109, 0.2)' },
        horzLines: { color: 'rgba(62, 78, 109, 0.2)' },
      },
      rightPriceScale: { borderColor: 'rgba(62, 78, 109, 0.5)' },
      timeScale: {
        borderColor: 'rgba(62, 78, 109, 0.5)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
    });
    const series = chart.addSeries(LineSeries, {
      color: '#D4AF37',
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  const fetchData = async () => {
    if (!seriesRef.current) return;
    setLoading(true);
    try {
      const params: Record<string, number> = { limit: 5000 };
      if (meta.hours > 0) params.from_ts = Date.now() - meta.hours * 3600 * 1000;
      const res = await apiClient.get<EquityPoint[]>('/journal/equity', { params });
      const pts = res.data || [];
      // de-dup 同 ts 的點：lightweight-charts 不能有兩個一樣 time 的 LineData
      const seen = new Set<number>();
      const data: LineData<Time>[] = [];
      for (const p of pts) {
        const tSec = Math.floor(p.ts / 1000);
        // 對相同秒的 fill：保留最後一個 realized_pnl，覆寫先前
        if (seen.has(tSec)) {
          data[data.length - 1] = { time: tSec as Time, value: p.realized_pnl };
        } else {
          seen.add(tSec);
          data.push({ time: tSec as Time, value: p.realized_pnl });
        }
      }
      seriesRef.current.setData(data);
      setLastPoint(pts.length > 0 ? pts[pts.length - 1] : null);
      chartRef.current?.timeScale().fitContent();
    } catch (e) {
      // 靜默：journal 為空時 backend 也是回 [] 不算錯
      seriesRef.current.setData([]);
      setLastPoint(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  const cumulative = lastPoint?.realized_pnl ?? 0;
  const cumulativeColor = cumulative > 0 ? COLOR_UP : cumulative < 0 ? COLOR_DOWN : COLOR_FLAT;

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <TrendingUp className="w-3.5 h-3.5 text-amber-400" />
          已實現損益曲線
          {lastPoint && (
            <span className="ml-2 font-mono tabular-nums" style={{ color: cumulativeColor }}>
              {cumulative > 0 ? '+' : ''}{cumulative.toLocaleString()}
            </span>
          )}
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
            title="重新整理"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
};

export default EquityCurvePanel;
