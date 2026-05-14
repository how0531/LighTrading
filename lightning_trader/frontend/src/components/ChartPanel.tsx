/**
 * ChartPanel — 1 分鐘 K 棒 + 即時更新
 *
 * 機制：
 *   1. mount / targetSymbol 變更：GET /api/kbars 拿歷史
 *   2. 同時訂閱 TradingContext.quote 取最新 Price 與 Volume
 *      → 把當前分鐘的 K 棒 high/low/close/volume 即時更新
 *      → 跨入新分鐘時 push 一根新 bar
 *
 * 用 TradingView lightweight-charts (MIT, ~30KB gzipped)
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type Time,
} from 'lightweight-charts';
import { useTradingContext } from '../contexts/TradingContext';
import { apiClient } from '../api/client';

const PNL_COLOR_UP = '#EF4444';     // 台灣：紅 = 漲
const PNL_COLOR_DOWN = '#10B981';   // 台灣：綠 = 跌

type Timeframe = '1m' | '5m' | '15m' | '60m';
const TIMEFRAMES: { id: Timeframe; label: string; seconds: number; days: number }[] = [
  { id: '1m',  label: '1m',  seconds: 60,    days: 1 },
  { id: '5m',  label: '5m',  seconds: 300,   days: 2 },
  { id: '15m', label: '15m', seconds: 900,   days: 5 },
  { id: '60m', label: '60m', seconds: 3600,  days: 15 },
];

interface KBarApi {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

// 把 unix 秒 floor 到當 bin（依 timeframe 秒數）起點
function alignToBucket(unix: number, secs: number): number {
  return Math.floor(unix / secs) * secs;
}

// 把 1m bars 聚合到任意 timeframe（>= 1m）
function aggregate1mBars(bars: KBarApi[], bucketSecs: number): KBarApi[] {
  if (bucketSecs <= 60) return bars;
  const buckets = new Map<number, KBarApi>();
  for (const b of bars) {
    const k = alignToBucket(b.time, bucketSecs);
    const existing = buckets.get(k);
    if (!existing) {
      buckets.set(k, { ...b, time: k });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low  = Math.min(existing.low, b.low);
      existing.close = b.close;
      existing.volume += b.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

const ChartPanel: React.FC = () => {
  const { targetSymbol, quote } = useTradingContext();
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const tfMeta = useMemo(() => TIMEFRAMES.find((t) => t.id === timeframe)!, [timeframe]);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastBarRef = useRef<CandlestickData<Time> | null>(null);
  const lastVolRef = useRef<HistogramData<Time> | null>(null);

  // 初始化圖表（mount 一次）
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
        vertLines: { color: 'rgba(62, 78, 109, 0.25)' },
        horzLines: { color: 'rgba(62, 78, 109, 0.25)' },
      },
      rightPriceScale: { borderColor: 'rgba(62, 78, 109, 0.5)' },
      timeScale: {
        borderColor: 'rgba(62, 78, 109, 0.5)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: PNL_COLOR_UP,
      downColor: PNL_COLOR_DOWN,
      borderUpColor: PNL_COLOR_UP,
      borderDownColor: PNL_COLOR_DOWN,
      wickUpColor: PNL_COLOR_UP,
      wickDownColor: PNL_COLOR_DOWN,
    });
    const vol = chart.addSeries(HistogramSeries, {
      color: 'rgba(212, 175, 55, 0.4)',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candle;
    volSeriesRef.current = vol;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volSeriesRef.current = null;
    };
  }, []);

  // 切換商品或 timeframe：拉 1m kbars → aggregate → 填圖
  useEffect(() => {
    if (!targetSymbol || !candleSeriesRef.current || !volSeriesRef.current) return;
    let cancelled = false;

    apiClient.get<KBarApi[]>('/kbars', { params: { symbol: targetSymbol, days: tfMeta.days } })
      .then((res) => {
        if (cancelled) return;
        const raw = res.data || [];
        const bars = aggregate1mBars(raw, tfMeta.seconds);
        const candles: CandlestickData<Time>[] = bars.map((b) => ({
          time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close,
        }));
        const vols: HistogramData<Time>[] = bars.map((b) => ({
          time: b.time as Time,
          value: b.volume,
          color: b.close >= b.open ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)',
        }));
        candleSeriesRef.current!.setData(candles);
        volSeriesRef.current!.setData(vols);
        lastBarRef.current = candles[candles.length - 1] ?? null;
        lastVolRef.current = vols[vols.length - 1] ?? null;
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {
        // 沒登入或拉不到就清空；避免顯示其他商品殘留
        candleSeriesRef.current!.setData([]);
        volSeriesRef.current!.setData([]);
        lastBarRef.current = null;
        lastVolRef.current = null;
      });

    return () => { cancelled = true; };
  }, [targetSymbol, tfMeta.seconds, tfMeta.days]);

  // Live update：每次 quote 變動，更新或新增當分鐘 bar
  useEffect(() => {
    if (!quote || !candleSeriesRef.current || !volSeriesRef.current) return;
    const price = quote.Price;
    if (!(price > 0)) return;

    // quote.TickTime 是 ISO 字串；解析到 unix 秒，再對齊到當前 timeframe 的 bin
    const tickTime = quote.TickTime ? Date.parse(quote.TickTime) / 1000 : Date.now() / 1000;
    const barTime = alignToBucket(tickTime, tfMeta.seconds);

    // tick volume 是「自上次 quote 起的累計量」？Shioaji 的 Volume 是該 tick 的 volume，不累計。
    // 直接拿 quote.Volume 加到當前 bar volume；之前的 quote 用 ref 拿
    const tickVol = quote.Volume || 0;

    const prevBar = lastBarRef.current;
    if (prevBar && Number(prevBar.time) === barTime) {
      // 同一根 bar → update close, high, low + 累積 volume
      const newBar: CandlestickData<Time> = {
        time: barTime as Time,
        open: prevBar.open,
        high: Math.max(prevBar.high, price),
        low: Math.min(prevBar.low, price),
        close: price,
      };
      candleSeriesRef.current.update(newBar);
      lastBarRef.current = newBar;

      const prevVolValue = lastVolRef.current?.value ?? 0;
      const newVol: HistogramData<Time> = {
        time: barTime as Time,
        value: prevVolValue + tickVol,
        color: price >= newBar.open ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)',
      };
      volSeriesRef.current.update(newVol);
      lastVolRef.current = newVol;
    } else {
      // 跨分鐘 → push 新 bar
      const newBar: CandlestickData<Time> = {
        time: barTime as Time,
        open: price, high: price, low: price, close: price,
      };
      candleSeriesRef.current.update(newBar);
      lastBarRef.current = newBar;
      const newVol: HistogramData<Time> = {
        time: barTime as Time,
        value: tickVol,
        color: 'rgba(212, 175, 55, 0.4)',
      };
      volSeriesRef.current.update(newVol);
      lastVolRef.current = newVol;
    }
  }, [quote, tfMeta.seconds]);

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <span className="w-1 h-3.5 bg-amber-500 rounded-full"></span>
          K 線圖 ({targetSymbol || '—'})
        </h3>
        <div className="flex items-center gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.id}
              onClick={() => setTimeframe(tf.id)}
              className={`px-2 py-0.5 text-[10px] font-bold rounded border transition-colors ${
                timeframe === tf.id
                  ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]'
                  : 'bg-slate-900 text-slate-500 border-slate-700 hover:text-slate-300'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
};

export default ChartPanel;
