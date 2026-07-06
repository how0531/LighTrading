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
 * Sprint 34：新增 symbol / compact props 供多圖看盤內嵌。
 * Sprint E：指標系統重構 —— 舊 MA20/MA60/VWAP/RSI/EMA20/BOLL toggle 與常駐
 *   volume histogram 遷移為 settings.chart 指標系統（預設 SMA20 + 成交量）,
 *   接線在 hooks/useIndicators（v5 panes：主圖 overlay + 副圖獨立 pane）,
 *   工具列「指標」開啟 IndicatorPicker（含自訂 JS 指標）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type SeriesMarker,
  type CandlestickData,
  type Time,
  type MouseEventParams,
} from 'lightweight-charts';
import { useQuotes, useTradingCore } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { apiClient, normalizeApiError } from '../api/client';
import { symbolMatches } from '../utils/instrument';
import { useIndicators } from '../hooks/useIndicators';
import IndicatorPicker from './IndicatorPicker';

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
  /** 精簡模式:header 縮小（多圖宮格內用） */
  compact?: boolean;
}

const ChartPanel: React.FC<ChartPanelProps> = ({ symbol, compact = false }) => {
  const { targetSymbol, workingOrders, accountSummary, scheduleOrderRefresh } = useTradingCore();
  const { quote, watchlistQuotes } = useQuotes(); // K 線需要 tick 資料
  const { settings } = useSettings();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  // 有 symbol prop → 固定該商品；否則跟隨 targetSymbol
  const effSymbol = (symbol ?? targetSymbol) || '';
  const isPinned = !!symbol;
  const mini = isPinned ? watchlistQuotes[effSymbol.toUpperCase()] : undefined;
  // 互動下單只在「跟隨主商品」時啟用；pinned（多圖宮格）保持純顯示
  const interactive = !isPinned;
  const [chartQty, setChartQty] = useState(1);
  // 讓 subscribeClick 的 handler（mount 一次）讀到最新值，不必每次 re-subscribe
  const clickStateRef = useRef({
    symbol: effSymbol,
    qty: chartQty,
    price: 0,
    interactive,
    confirmNeeded: true,
    toast,
    confirm,
    scheduleOrderRefresh,
  });

  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const [barsVersion, setBarsVersion] = useState(0); // kbars 載入完成的訊號（成交標記/指標重算用）
  const [pickerOpen, setPickerOpen] = useState(false); // Sprint E：指標選擇器
  const tfMeta = useMemo(() => TIMEFRAMES.find((t) => t.id === timeframe)!, [timeframe]);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lastBarRef = useRef<CandlestickData<Time> | null>(null);
  // 保留最近的聚合 bars,給指標計算用（tick 時就地更新最後一根）
  const aggregatedBarsRef = useRef<KBarApi[]>([]);
  // 目前 K 棒快取所屬的商品：/kbars async 回來前 live-update 不得套用新商品 tick,
  // 否則會把新商品價寫進舊商品的 bars/series（Frankenstein 閃現）。
  const loadedSymbolRef = useRef<string | null>(null);
  // Sprint B：圖上委託/持倉價格線 + 成交標記
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  // Sprint E：hover legend（useIndicators 直接寫 DOM）
  const legendRef = useRef<HTMLDivElement>(null);

  // 初始化圖表（mount 一次）
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#101623' },
        textColor: '#94A3B8',
        fontFamily: 'Barlow, monospace',
        // Sprint E：副圖 pane 分隔線（v5 panes）
        panes: {
          separatorColor: 'rgba(62, 78, 109, 0.5)',
          separatorHoverColor: 'rgba(212, 175, 55, 0.3)',
          enableResize: true,
        },
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

    chartRef.current = chart;
    candleSeriesRef.current = candle;
    markersPluginRef.current = createSeriesMarkers(candle, []);

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      markersPluginRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // Sprint E：指標系統接線（chart 初始化 effect 之後呼叫,確保 effects 順序）
  const { onBarsTick } = useIndicators({
    chartRef,
    barsRef: aggregatedBarsRef,
    barsVersion,
    chartSettings: settings.chart,
    legendRef,
  });

  // 切換商品或 timeframe：拉 1m kbars → aggregate → 填圖
  useEffect(() => {
    if (!effSymbol || !candleSeriesRef.current) return;
    let cancelled = false;
    // 切商品/週期：先作廢舊快取,標記「尚無已載入商品」,live-update 在 /kbars
    // 回來前不會誤把新商品 tick 套到舊 bars（見 loadedSymbolRef 守門）。
    loadedSymbolRef.current = null;
    lastBarRef.current = null;
    aggregatedBarsRef.current = [];

    apiClient.get<KBarApi[]>('/kbars', { params: { symbol: effSymbol, days: tfMeta.days } })
      .then((res) => {
        if (cancelled) return;
        const raw = res.data || [];
        const bars = aggregate1mBars(raw, tfMeta.seconds);
        const candles: CandlestickData<Time>[] = bars.map((b) => ({
          time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close,
        }));
        candleSeriesRef.current!.setData(candles);
        lastBarRef.current = candles[candles.length - 1] ?? null;
        aggregatedBarsRef.current = bars;
        loadedSymbolRef.current = effSymbol; // 標記快取已屬此商品 → live-update 可套用
        setBarsVersion((v) => v + 1); // 通知成交標記/指標 effect：bars 已就緒
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {
        if (cancelled) return;
        // 沒登入或拉不到就清空；避免顯示其他商品殘留
        candleSeriesRef.current!.setData([]);
        aggregatedBarsRef.current = [];
        lastBarRef.current = null;
        loadedSymbolRef.current = effSymbol; // 已知為空,tick 從空狀態接續（仍屬此商品）
        setBarsVersion((v) => v + 1); // 指標同步清空
      });

    return () => { cancelled = true; };
  }, [effSymbol, tfMeta.seconds, tfMeta.days]);

  // Live update：把最新成交價更新到當前 timeframe 的 K 棒
  // 來源依 isPinned 決定：pinned 用 MiniQuote（close-only），否則用主 quote（含量）
  useEffect(() => {
    // /kbars 尚未為當前商品載入完成 → 不套用 tick,避免污染舊商品 K 棒
    if (!effSymbol || loadedSymbolRef.current !== effSymbol) return;
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
    if (!candleSeriesRef.current) return;

    const barTime = alignToBucket(tickTimeSec, tfMeta.seconds);
    const prevBar = lastBarRef.current;
    if (prevBar && Number(prevBar.time) === barTime) {
      // 同一根 bar → update close, high, low
      const newBar: CandlestickData<Time> = {
        time: barTime as Time,
        open: prevBar.open,
        high: Math.max(prevBar.high, price),
        low: Math.min(prevBar.low, price),
        close: price,
      };
      candleSeriesRef.current.update(newBar);
      lastBarRef.current = newBar;

      // 同步 bars 快取（指標資料源）：volume 累加
      const bars = aggregatedBarsRef.current;
      const lastIdx = bars.length - 1;
      if (lastIdx >= 0 && bars[lastIdx].time === barTime) {
        bars[lastIdx] = {
          ...bars[lastIdx],
          high: newBar.high,
          low: newBar.low,
          close: price,
          volume: bars[lastIdx].volume + tickVol,
        };
      } else if (barTime > (bars[lastIdx]?.time ?? -Infinity)) {
        bars.push({ time: barTime, open: newBar.open, high: newBar.high, low: newBar.low, close: price, volume: tickVol });
      }
    } else {
      // 跨 bin → push 新 bar
      const newBar: CandlestickData<Time> = {
        time: barTime as Time,
        open: price, high: price, low: price, close: price,
      };
      candleSeriesRef.current.update(newBar);
      lastBarRef.current = newBar;
      const bars = aggregatedBarsRef.current;
      if (barTime > (bars[bars.length - 1]?.time ?? -Infinity)) {
        bars.push({ time: barTime, open: price, high: price, low: price, close: price, volume: tickVol });
      }
    }
    // 指標增量更新最後一點（內建 series.update；自訂走 worker 節流）
    onBarsTick();
  }, [quote, mini, isPinned, tfMeta.seconds, effSymbol, onBarsTick]);

  // ── Sprint B：圖上委託單/持倉均價 價格線 ─────────────────
  useEffect(() => {
    const candle = candleSeriesRef.current;
    if (!candle) return;
    for (const line of priceLinesRef.current) {
      try { candle.removePriceLine(line); } catch { /* chart 卸載中 */ }
    }
    priceLinesRef.current = [];
    if (!interactive || !effSymbol) return;

    const lines: IPriceLine[] = [];
    // 持倉均價：金色虛線
    const pos = (accountSummary.positions || []).find((p) => symbolMatches(effSymbol, p.symbol));
    if (pos && pos.price > 0) {
      lines.push(candle.createPriceLine({
        price: pos.price,
        color: '#D4AF37',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `${pos.direction === 'Buy' ? '多' : '空'}${pos.qty} 成本`,
      }));
    }
    // 活躍委託：買紅/賣綠實線，標示（已成交/總量）
    for (const o of workingOrders) {
      if (!symbolMatches(effSymbol, o.symbol) || !(o.price > 0)) continue;
      const isBuy = o.action === 'Buy';
      const filled = o.filled_qty > 0 ? `${o.filled_qty}/` : '';
      lines.push(candle.createPriceLine({
        price: o.price,
        color: isBuy ? PNL_COLOR_UP : PNL_COLOR_DOWN,
        lineWidth: 1,
        lineStyle: 0,
        axisLabelVisible: true,
        title: `${isBuy ? '買' : '賣'}${filled}${o.qty}`,
      }));
    }
    priceLinesRef.current = lines;
  }, [interactive, effSymbol, workingOrders, accountSummary.positions]);

  // ── Sprint B：當日成交箭頭標記（買上/賣下）────────────────
  useEffect(() => {
    const plugin = markersPluginRef.current;
    if (!plugin) return;
    if (!interactive || !effSymbol) { plugin.setMarkers([]); return; }
    let cancelled = false;
    apiClient.get('/order_history')
      .then((res) => {
        if (cancelled || !markersPluginRef.current) return;
        const bars = aggregatedBarsRef.current;
        if (!bars.length) { markersPluginRef.current.setMarkers([]); return; }
        const firstBar = bars[0].time;
        const lastBar = bars[bars.length - 1].time;
        interface HistOrder {
          symbol: string; action: string; price: number; qty: number;
          status: string; filled_qty: number; filled_avg_price: number; time: string;
        }
        const orders = ((res.data?.orders || []) as HistOrder[])
          .filter((o) => symbolMatches(effSymbol, o.symbol)
            && (o.status === 'Filled' || (o.filled_qty ?? 0) > 0));
        const markers: SeriesMarker<Time>[] = [];
        for (const o of orders) {
          const parsed = Date.parse(o.time) / 1000;
          if (!Number.isFinite(parsed)) continue;
          // 對齊 bar bucket 並夾進現有資料範圍（時區/盤別偏差時退到最近的 bar）
          let t = alignToBucket(parsed, tfMeta.seconds);
          if (t < firstBar) t = firstBar;
          if (t > lastBar) t = lastBar;
          const isBuy = o.action === 'Buy';
          markers.push({
            time: t as Time,
            position: isBuy ? 'belowBar' : 'aboveBar',
            shape: isBuy ? 'arrowUp' : 'arrowDown',
            color: isBuy ? PNL_COLOR_UP : PNL_COLOR_DOWN,
            text: `${isBuy ? 'B' : 'S'}${o.filled_qty || o.qty}`,
          });
        }
        markers.sort((a, b) => Number(a.time) - Number(b.time));
        markersPluginRef.current.setMarkers(markers);
      })
      .catch(() => { /* 未登入等情況：不畫標記 */ });
    return () => { cancelled = true; };
  }, [interactive, effSymbol, tfMeta.seconds, workingOrders, barsVersion]);

  // ── Sprint B：點擊圖表下單（現價下=掛買、上=掛賣）─────────
  // clickStateRef 每 render 更新，click handler 只在 mount 訂閱一次
  useEffect(() => {
    clickStateRef.current = {
      symbol: effSymbol,
      qty: chartQty,
      price: (isPinned ? (mini?.price ?? 0) : (quote?.Price ?? 0)) || 0,
      interactive,
      confirmNeeded: settings.confirmations.placeOrder && !settings.isCombatMode,
      toast,
      confirm,
      scheduleOrderRefresh,
    };
  });

  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleSeriesRef.current;
    if (!chart || !candle) return;

    const onClick = async (param: MouseEventParams<Time>) => {
      const st = clickStateRef.current;
      if (!st.interactive || !st.symbol || !param.point) return;
      const raw = candle.coordinateToPrice(param.point.y);
      if (raw == null || !(raw > 0)) return;
      if (!(st.price > 0)) {
        st.toast.warn('尚無現價，無法判斷買賣方向');
        return;
      }
      const px = Number(raw.toFixed(2));
      const action: 'Buy' | 'Sell' = px <= st.price ? 'Buy' : 'Sell';
      const dir = action === 'Buy' ? '買進' : '賣出';
      // 與 useDOMLogic 一致：前端確認過即帶 confirm:true 授權後端 WARNING；
      // 戰鬥模式不預先授權，收到 409 再問一次
      let preConfirmed = false;
      if (st.confirmNeeded) {
        const ok = await st.confirm({
          title: '圖表下單',
          message: `確認${dir} ${st.symbol} ${st.qty} 單位 @ ${px}？（圖表下單）`,
          confirmLabel: `確認${dir}`,
        });
        if (!ok) return;
        preConfirmed = true;
      }
      const payload = {
        symbol: st.symbol, price: px, action, qty: st.qty,
        order_type: 'ROD', price_type: 'LMT', order_cond: 'Cash', order_lot: 'Common',
        ...(preConfirmed ? { confirm: true } : {}),
      };
      apiClient.post('/place_order', payload)
        .then(() => {
          st.toast.success(`圖表下單：${dir} ${st.qty} @ ${px}`);
          st.scheduleOrderRefresh();
        })
        .catch(async (e) => {
          const err = normalizeApiError(e);
          if (err.status === 409 && err.code === 'CONFIRM_REQUIRED') {
            const msg = [err.user_msg, ...(err.warnings ?? [])].filter(Boolean).join('\n');
            // 風控警告：danger 對話框（promise-based，不阻塞圖表更新）
            const ok = await st.confirm({
              title: '風控警告',
              message: msg,
              confirmLabel: '確認送單',
              danger: true,
            });
            if (ok) {
              try {
                await apiClient.post('/place_order', { ...payload, confirm: true });
                st.toast.success(`圖表下單：${dir} ${st.qty} @ ${px}`);
                st.scheduleOrderRefresh();
              } catch (e2) {
                st.toast.error(normalizeApiError(e2).user_msg || '圖表下單失敗');
              }
            } else {
              st.toast.info('已取消下單');
            }
            return;
          }
          st.toast.error(err.user_msg || '圖表下單失敗');
        });
    };

    chart.subscribeClick(onClick);
    return () => { chart.unsubscribeClick(onClick); };
  }, []);

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

  const activeCount = settings.chart.active.length;

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className={`${compact ? 'px-2 py-1' : 'px-3 py-2'} border-b border-slate-700/50 flex items-center justify-between gap-1`}>
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2 min-w-0">
          <span className="w-1 h-3.5 bg-amber-500 rounded-full flex-shrink-0"></span>
          <span className="truncate">{compact ? (effSymbol || '—') : `K 線圖 (${effSymbol || '—'})`}</span>
        </h3>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          <button
            onClick={() => setPickerOpen(true)}
            className="px-2 py-0.5 text-[10px] font-bold rounded border bg-slate-900 text-slate-400 border-slate-700 hover:text-[#D4AF37] hover:border-[#D4AF37]/60 transition-colors"
            title="技術指標（選擇 / 參數 / 樣式 / 自訂 JS）— 設定為所有圖表共用"
          >
            ƒ 指標{activeCount > 0 ? ` ${activeCount}` : ''}
          </button>
          {!compact && <div className="w-px h-4 bg-slate-700 mx-1" />}
          {interactive && !compact && (
            <label className="flex items-center gap-1 ml-1" title="圖表點擊下單口數">
              <span className="text-[9px] text-slate-500 font-bold">口數</span>
              <input
                type="number" min={1} max={499} value={chartQty}
                onChange={(e) => setChartQty(Math.max(1, Math.min(499, parseInt(e.target.value || '1', 10) || 1)))}
                className="w-11 bg-[#101623] border border-slate-700 rounded text-right text-slate-200 text-[10px] px-1 py-0.5"
              />
            </label>
          )}
          {timeframeButtons}
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="w-full h-full" />
        {/* Sprint E：指標 hover legend（useIndicators 直接寫入,無 React 重繪） */}
        <div
          ref={legendRef}
          style={{ display: 'none' }}
          className="absolute top-1 left-1 z-10 pointer-events-none select-none text-[10px] leading-snug bg-[#101623]/80 border border-slate-700/50 rounded px-1.5 py-1 space-y-0.5"
        />
        {interactive && (
          <div className="absolute bottom-1 left-1 z-10 text-[9px] text-slate-600 pointer-events-none select-none">
            點擊圖面掛限價單（現價下=買 / 上=賣）
          </div>
        )}
      </div>
      <IndicatorPicker
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        getBars={() => aggregatedBarsRef.current}
      />
    </div>
  );
};

export default ChartPanel;
