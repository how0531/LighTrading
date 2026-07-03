/**
 * ChartPanel — K 棒 + 即時更新
 *
 * 機制：
 *   1. mount / 目標商品變更：GET /api/kbars 拿歷史
 *   2. 即時更新最後一根 K 棒：
 *      - 預設（不傳 symbol）：跟隨 TradingContext.targetSymbol,吃主 quote（含單筆量,累加 volume）
 *      - 傳 symbol：固定顯示該商品,吃 watchlistQuotes[symbol] 的 MiniQuote 做 close-only 更新
 *        （MiniQuote 無單筆量,故只更新 high/low/close,volume 不動）
 *
 * 用 TradingView lightweight-charts (MIT, ~30KB gzipped)
 *
 * Sprint 34：新增 symbol / compact props 供多圖看盤內嵌;新增 EMA20 / 布林通道 toggle。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
} from 'lightweight-charts';
import { useQuotes, useTradingCore } from '../contexts/TradingContext';
import { apiClient } from '../api/client';
import {
  computeSMA as _sma, computeVWAP as _vwap, computeRSI as _rsi,
  computeEMA as _ema, computeBollinger as _boll,
} from '../utils/indicators';

// 包成 LineData<Time>[]：indicator utils 用 number；lightweight-charts 要 Time 型別 cast
function computeSMA(bars: KBarApi[], period: number): LineData<Time>[] {
  return _sma(bars, period).map((p) => ({ time: p.time as Time, value: p.value }));
}
function computeVWAP(bars: KBarApi[]): LineData<Time>[] {
  return _vwap(bars).map((p) => ({ time: p.time as Time, value: p.value }));
}
function computeRSI(bars: KBarApi[], period: number = 14): LineData<Time>[] {
  return _rsi(bars, period).map((p) => ({ time: p.time as Time, value: p.value }));
}
function computeEMA(bars: KBarApi[], period: number): LineData<Time>[] {
  return _ema(bars, period).map((p) => ({ time: p.time as Time, value: p.value }));
}
function computeBoll(bars: KBarApi[], period = 20, mult = 2) {
  const b = _boll(bars, period, mult);
  const cast = (arr: Array<{ time: number; value: number }>): LineData<Time>[] =>
    arr.map((p) => ({ time: p.time as Time, value: p.value }));
  return { upper: cast(b.upper), middle: cast(b.middle), lower: cast(b.lower) };
}

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

interface ChartPanelProps {
  /** 傳入則固定顯示該商品（多圖看盤用）;不傳則跟隨 targetSymbol */
  symbol?: string;
  /** 精簡模式:header 縮小、指標 toggle 收進選單（多圖宮格內用） */
  compact?: boolean;
}

// 指標 toggle 按鈕（hoist 到模組層,避免在 render 內定義 component）
const IndicatorBtn: React.FC<{ on: boolean; onClick: () => void; label: string; cls: string; title: string }> =
  ({ on, onClick, label, cls, title }) => (
    <button
      onClick={onClick}
      className={`px-1.5 py-0.5 text-[10px] font-bold rounded border transition-colors ${
        on ? cls : 'bg-slate-900 text-slate-500 border-slate-700'
      }`}
      title={title}
    >{label}</button>
  );

const ChartPanel: React.FC<ChartPanelProps> = ({ symbol, compact = false }) => {
  const { targetSymbol } = useTradingCore();
  const { quote, watchlistQuotes } = useQuotes(); // K 線需要 tick 資料
  // 有 symbol prop → 固定該商品；否則跟隨 targetSymbol
  const effSymbol = (symbol ?? targetSymbol) || '';
  const isPinned = !!symbol;
  const mini = isPinned ? watchlistQuotes[effSymbol.toUpperCase()] : undefined;

  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  // 指標 toggles
  const [showMA20, setShowMA20] = useState(!compact);
  const [showMA60, setShowMA60] = useState(!compact);
  const [showVWAP, setShowVWAP] = useState(!compact);
  const [showRSI, setShowRSI] = useState(false);     // Sprint 25 預設關（不在 candle 同 scale）
  const [showEMA20, setShowEMA20] = useState(false); // Sprint 34
  const [showBoll, setShowBoll] = useState(false);   // Sprint 34
  const [menuOpen, setMenuOpen] = useState(false);   // compact 模式的指標選單
  const tfMeta = useMemo(() => TIMEFRAMES.find((t) => t.id === timeframe)!, [timeframe]);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma60SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollUpSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollMidSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollLowSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const lastBarRef = useRef<CandlestickData<Time> | null>(null);
  const lastVolRef = useRef<HistogramData<Time> | null>(null);
  // 保留最近的聚合 bars，給指標重算用
  const aggregatedBarsRef = useRef<KBarApi[]>([]);

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

    // MA20 / MA60 / VWAP overlay。三條都共用 candle 的價格 scale，
    // 不另開 priceScaleId 避免疊壓 candle。lineWidth=1 保持輕量。
    const ma20 = chart.addSeries(LineSeries, {
      color: '#60a5fa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: 'MA20',
    });
    const ma60 = chart.addSeries(LineSeries, {
      color: '#a855f7', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: 'MA60',
    });
    const vwap = chart.addSeries(LineSeries, {
      color: '#D4AF37', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: 'VWAP',
    });
    // Sprint 34：EMA20（橘）與布林通道（上/中/下軌,青色系半透明,同 candle scale）
    const ema20 = chart.addSeries(LineSeries, {
      color: '#fb923c', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: 'EMA20',
    });
    const bollUp = chart.addSeries(LineSeries, {
      color: 'rgba(34, 211, 238, 0.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: 'BOLL+',
    });
    const bollMid = chart.addSeries(LineSeries, {
      color: 'rgba(34, 211, 238, 0.3)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, lineStyle: 2, title: 'BOLL',
    });
    const bollLow = chart.addSeries(LineSeries, {
      color: 'rgba(34, 211, 238, 0.55)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: 'BOLL-',
    });
    // RSI 走自己的 priceScale（0-100 範圍），與 candle 不共軸
    const rsi = chart.addSeries(LineSeries, {
      color: '#fb7185', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: 'RSI14',
      priceScaleId: 'rsi',
    });
    rsi.priceScale().applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candle;
    volSeriesRef.current = vol;
    ma20SeriesRef.current = ma20;
    ma60SeriesRef.current = ma60;
    vwapSeriesRef.current = vwap;
    rsiSeriesRef.current = rsi;
    ema20SeriesRef.current = ema20;
    bollUpSeriesRef.current = bollUp;
    bollMidSeriesRef.current = bollMid;
    bollLowSeriesRef.current = bollLow;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volSeriesRef.current = null;
      ma20SeriesRef.current = null;
      ma60SeriesRef.current = null;
      vwapSeriesRef.current = null;
      rsiSeriesRef.current = null;
      ema20SeriesRef.current = null;
      bollUpSeriesRef.current = null;
      bollMidSeriesRef.current = null;
      bollLowSeriesRef.current = null;
    };
  }, []);

  // 套用所有指標到對應 series（依 toggle 開關決定填資料或清空）
  const applyIndicators = (bars: KBarApi[]) => {
    ma20SeriesRef.current?.setData(showMA20 ? computeSMA(bars, 20) : []);
    ma60SeriesRef.current?.setData(showMA60 ? computeSMA(bars, 60) : []);
    vwapSeriesRef.current?.setData(showVWAP ? computeVWAP(bars) : []);
    rsiSeriesRef.current?.setData(showRSI ? computeRSI(bars, 14) : []);
    ema20SeriesRef.current?.setData(showEMA20 ? computeEMA(bars, 20) : []);
    if (showBoll) {
      const b = computeBoll(bars, 20, 2);
      bollUpSeriesRef.current?.setData(b.upper);
      bollMidSeriesRef.current?.setData(b.middle);
      bollLowSeriesRef.current?.setData(b.lower);
    } else {
      bollUpSeriesRef.current?.setData([]);
      bollMidSeriesRef.current?.setData([]);
      bollLowSeriesRef.current?.setData([]);
    }
  };

  // 切換商品或 timeframe：拉 1m kbars → aggregate → 填圖
  useEffect(() => {
    if (!effSymbol || !candleSeriesRef.current || !volSeriesRef.current) return;
    let cancelled = false;

    apiClient.get<KBarApi[]>('/kbars', { params: { symbol: effSymbol, days: tfMeta.days } })
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
        aggregatedBarsRef.current = bars;
        applyIndicators(bars);
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {
        // 沒登入或拉不到就清空；避免顯示其他商品殘留
        candleSeriesRef.current!.setData([]);
        volSeriesRef.current!.setData([]);
        ma20SeriesRef.current?.setData([]);
        ma60SeriesRef.current?.setData([]);
        vwapSeriesRef.current?.setData([]);
        rsiSeriesRef.current?.setData([]);
        ema20SeriesRef.current?.setData([]);
        bollUpSeriesRef.current?.setData([]);
        bollMidSeriesRef.current?.setData([]);
        bollLowSeriesRef.current?.setData([]);
        aggregatedBarsRef.current = [];
        lastBarRef.current = null;
        lastVolRef.current = null;
      });

    return () => { cancelled = true; };
    // applyIndicators 讀 toggle state 但每 render 重建,刻意不列入 deps（與既有寫法一致）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effSymbol, tfMeta.seconds, tfMeta.days]);

  // toggle 指標 → 從快取 bars 重算（無需 refetch）
  useEffect(() => {
    const bars = aggregatedBarsRef.current;
    if (!bars || bars.length === 0) return;
    applyIndicators(bars);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMA20, showMA60, showVWAP, showRSI, showEMA20, showBoll]);

  // Live update：把最新成交價更新到當前 timeframe 的 K 棒
  // 來源依 isPinned 決定：pinned 用 MiniQuote（close-only），否則用主 quote（含量）
  useEffect(() => {
    let price = 0;
    let tickTimeSec = Date.now() / 1000;
    let tickVol = 0;

    if (isPinned) {
      if (!mini || !(mini.price > 0)) return;
      price = mini.price;
      tickTimeSec = (mini.updatedAt || Date.now()) / 1000;
      // MiniQuote 沒有單筆量,只做 close-only：volume 不累加
    } else {
      if (!quote || !(quote.Price > 0)) return;
      price = quote.Price;
      tickTimeSec = quote.TickTime ? Date.parse(quote.TickTime) / 1000 : Date.now() / 1000;
      tickVol = quote.Volume || 0;
    }
    if (!candleSeriesRef.current || !volSeriesRef.current) return;

    const barTime = alignToBucket(tickTimeSec, tfMeta.seconds);
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

      if (tickVol > 0) {
        const prevVolValue = lastVolRef.current?.value ?? 0;
        const newVol: HistogramData<Time> = {
          time: barTime as Time,
          value: prevVolValue + tickVol,
          color: price >= newBar.open ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)',
        };
        volSeriesRef.current.update(newVol);
        lastVolRef.current = newVol;
      }
    } else {
      // 跨 bin → push 新 bar
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
  }, [quote, mini, isPinned, tfMeta.seconds]);

  const indicatorButtons = (
    <>
      <IndicatorBtn on={showMA20} onClick={() => setShowMA20((v) => !v)} label="MA20" title="20 期簡單移動平均"
        cls="bg-blue-500/20 text-blue-300 border-blue-400" />
      <IndicatorBtn on={showMA60} onClick={() => setShowMA60((v) => !v)} label="MA60" title="60 期簡單移動平均"
        cls="bg-purple-500/20 text-purple-300 border-purple-400" />
      <IndicatorBtn on={showEMA20} onClick={() => setShowEMA20((v) => !v)} label="EMA20" title="20 期指數移動平均"
        cls="bg-orange-500/20 text-orange-300 border-orange-400" />
      <IndicatorBtn on={showBoll} onClick={() => setShowBoll((v) => !v)} label="BB" title="布林通道 (20, 2σ)"
        cls="bg-cyan-500/20 text-cyan-300 border-cyan-400" />
      <IndicatorBtn on={showVWAP} onClick={() => setShowVWAP((v) => !v)} label="VWAP" title="累積成交量加權均價"
        cls="bg-amber-500/20 text-amber-300 border-amber-400" />
      <IndicatorBtn on={showRSI} onClick={() => setShowRSI((v) => !v)} label="RSI" title="Wilder RSI (14)，獨立 scale 在圖下緣"
        cls="bg-pink-500/20 text-pink-300 border-pink-400" />
    </>
  );

  const timeframeButtons = TIMEFRAMES.map((tf) => (
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
  ));

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className={`${compact ? 'px-2 py-1' : 'px-3 py-2'} border-b border-slate-700/50 flex items-center justify-between gap-1`}>
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2 min-w-0">
          <span className="w-1 h-3.5 bg-amber-500 rounded-full flex-shrink-0"></span>
          <span className="truncate">{compact ? (effSymbol || '—') : `K 線圖 (${effSymbol || '—'})`}</span>
        </h3>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          {compact ? (
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="px-1.5 py-0.5 text-[10px] font-bold rounded border bg-slate-900 text-slate-400 border-slate-700 hover:text-slate-200"
                title="指標"
              >指標 ▾</button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 flex flex-wrap gap-1 p-2 bg-slate-900 border border-slate-700 rounded shadow-xl w-40">
                  {indicatorButtons}
                </div>
              )}
            </div>
          ) : (
            <>
              {indicatorButtons}
              <div className="w-px h-4 bg-slate-700 mx-1" />
            </>
          )}
          {timeframeButtons}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
};

export default ChartPanel;
