/**
 * useIndicators — 指標系統的圖表接線（Sprint E）
 *
 * 職責：
 *   - 依 settings.chart.active 啟用清單建立/銷毀 lightweight-charts series
 *     （v5 panes：主圖 overlay 掛 paneIndex 0 與 candle 共 price scale；
 *      每個副圖指標各佔獨立 pane,主 pane stretch 3、副 pane 各 1）
 *   - timeframe/symbol 切換（barsVersion 變更）→ 全量重算 setData
 *   - 結構變更（新增/移除/排序/參數/自訂代碼）→ 全部重建（正確性優先）
 *   - 樣式/顯隱變更 → 就地 applyOptions（不重建,避免 color picker 拖曳閃爍）
 *   - 即時 tick（onBarsTick）→ 內建指標全量重算但只 series.update 最後一點；
 *     自訂指標走 worker,節流 ≥800ms
 *   - crosshair hover → 把各指標當前值寫進 legendRef（直接操作 DOM,
 *     避免高頻 setState 重繪整個 ChartPanel）
 */
import { useEffect, useMemo, useRef, useCallback } from 'react';
import {
  LineSeries,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type LineData,
  type LineWidth,
  type MouseEventParams,
  type SeriesType,
} from 'lightweight-charts';
import type { Candle, IndicatorPoint } from '../utils/indicators';
import {
  safeCompute,
  type IndicatorLineDef,
  type LineStrokeStyle,
} from '../utils/indicatorRegistry';
import {
  isCustomIndicatorId,
  resolveIndicatorInfo,
  resolveLineStyle,
  type ActiveIndicatorConfig,
  type ChartIndicatorSettings,
  type CustomIndicatorDef,
} from '../utils/chartIndicatorSettings';
import { defaultParamsOf } from '../utils/indicatorRegistry';
import { IndicatorWorkerClient } from '../utils/indicatorWorkerClient';
import type { CustomRunResult } from '../utils/customIndicator';

type AnySeries = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;

interface ManagedLine {
  key: string;
  label: string;
  series: AnySeries;
  kind: 'line' | 'histogram';
  /** 線定義預設樣式（applyOptions 時與覆寫合併） */
  defColor: string;
  defWidth: 1 | 2 | 3;
  defStroke: LineStrokeStyle;
  /** 上次套用的點數（自訂指標 update-or-setData 判斷用） */
  lastLen: number;
}

interface ManagedInstance {
  cfg: ActiveIndicatorConfig;
  isCustom: boolean;
  /** 副圖 pane 索引（自訂指標於重建時同步佔位,worker 回來掛上） */
  subPaneIndex: number | null;
  /**
   * 自訂指標的 pane 佔位 series（隱形、無資料）。
   * lightweight-charts 的 addSeries(paneIndex) 會把索引 clamp 到當前 pane 數,
   * 且 pane 一空就自動移除（索引全部左移）——必須同步放一條佔位 series
   * 把 pane「實際佔住」,worker 異步回來時索引才穩定。
   */
  placeholder: AnySeries | null;
  lines: ManagedLine[];
}

const STROKE_TO_LINESTYLE: Record<LineStrokeStyle, LineStyle> = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
};

const MAIN_PANE_STRETCH = 3;
const SUB_PANE_STRETCH = 1;
const CUSTOM_TICK_THROTTLE_MS = 800;
const CUSTOM_FALLBACK_COLORS = ['#60a5fa', '#fb923c', '#4ade80', '#e879f9', '#22d3ee', '#facc15'];

function toLineData(points: IndicatorPoint[]): LineData<Time>[] {
  return points.map((pt) => (
    pt.color
      ? { time: pt.time as Time, value: pt.value, color: pt.color }
      : { time: pt.time as Time, value: pt.value }
  ));
}

function setSeriesData(series: AnySeries, points: IndicatorPoint[]): void {
  (series as ISeriesApi<'Line'>).setData(toLineData(points));
}

function updateSeriesLast(series: AnySeries, point: IndicatorPoint): void {
  (series as ISeriesApi<'Line'>).update(toLineData([point])[0]);
}

function formatIndicatorValue(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100_000) return Math.round(v).toLocaleString();
  if (abs >= 1000) return v.toFixed(1);
  return v.toFixed(2);
}

export interface UseIndicatorsOptions {
  chartRef: React.RefObject<IChartApi | null>;
  /** 聚合後 K 棒快取（ChartPanel 的 aggregatedBarsRef,tick 時就地更新） */
  barsRef: React.RefObject<Candle[]>;
  /** kbars 載入完成訊號（symbol/timeframe 切換即重算） */
  barsVersion: number;
  chartSettings: ChartIndicatorSettings;
  /** hover legend 目標節點（hook 直接寫 DOM） */
  legendRef: React.RefObject<HTMLDivElement | null>;
}

export interface UseIndicatorsApi {
  /** 即時 tick 後呼叫：內建指標增量更新最後一點,自訂指標節流重算 */
  onBarsTick: () => void;
}

export function useIndicators(opts: UseIndicatorsOptions): UseIndicatorsApi {
  const { chartRef, barsRef, barsVersion, chartSettings, legendRef } = opts;

  const instancesRef = useRef<Map<string, ManagedInstance>>(new Map());
  const genRef = useRef(0);
  const settingsRef = useRef(chartSettings);
  settingsRef.current = chartSettings;
  const workerRef = useRef<IndicatorWorkerClient | null>(null);
  const customTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCustomRunRef = useRef(0);

  // 結構 key：清單成員/順序/參數/自訂代碼 → 觸發全部重建
  const structureKey = useMemo(
    () => JSON.stringify({
      a: chartSettings.active.map((a) => [a.instanceId, a.indicatorId, a.params]),
      c: chartSettings.custom.map((c) => [c.id, c.code]),
    }),
    [chartSettings],
  );
  // 樣式 key：顯隱/顏色/線寬/線型 → 只 applyOptions
  const stylesKey = useMemo(
    () => JSON.stringify(chartSettings.active.map((a) => [a.instanceId, a.visible, a.styles])),
    [chartSettings],
  );

  const getWorker = useCallback((): IndicatorWorkerClient => {
    if (!workerRef.current) workerRef.current = new IndicatorWorkerClient();
    return workerRef.current;
  }, []);

  /** 移除本 hook 管理的所有 series,並收掉空的副圖 pane */
  const teardown = useCallback(() => {
    const chart = chartRef.current;
    for (const inst of instancesRef.current.values()) {
      for (const line of inst.lines) {
        try {
          chart?.removeSeries(line.series);
        } catch {
          // chart 已卸載 → 忽略
        }
      }
      if (inst.placeholder) {
        try {
          chart?.removeSeries(inst.placeholder);
        } catch {
          // chart 已卸載 → 忽略
        }
      }
    }
    instancesRef.current.clear();
    if (chart) {
      try {
        const panes = chart.panes();
        for (let i = panes.length - 1; i >= 1; i--) {
          if (panes[i].getSeries().length === 0) chart.removePane(i);
        }
      } catch {
        // chart 已卸載 → 忽略
      }
    }
  }, [chartRef]);

  /** 依當前 pane 數重配比例：主 pane 3、每個副 pane 1 */
  const applyPaneStretch = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      const panes = chart.panes();
      if (panes.length <= 1) return;
      panes[0].setStretchFactor(MAIN_PANE_STRETCH);
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(SUB_PANE_STRETCH);
    } catch {
      // chart 卸載中 → 忽略
    }
  }, [chartRef]);

  const createSeries = useCallback((
    def: Pick<IndicatorLineDef, 'color' | 'lineWidth' | 'lineStyle' | 'style' | 'format'>,
    cfg: ActiveIndicatorConfig,
    styleKey: string,
    paneIndex: number,
  ): { series: AnySeries; kind: 'line' | 'histogram'; st: ReturnType<typeof resolveLineStyle> } | null => {
    const chart = chartRef.current;
    if (!chart) return null;
    const st = resolveLineStyle(def, cfg.styles[styleKey]);
    const common = {
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      visible: cfg.visible,
      ...(def.format === 'volume' ? { priceFormat: { type: 'volume' as const } } : {}),
    };
    if (def.style === 'histogram') {
      const series = chart.addSeries(HistogramSeries, { ...common, color: st.color }, paneIndex);
      return { series, kind: 'histogram', st };
    }
    const series = chart.addSeries(LineSeries, {
      ...common,
      color: st.color,
      lineWidth: st.lineWidth as LineWidth,
      lineStyle: STROKE_TO_LINESTYLE[st.lineStyle],
    }, paneIndex);
    return { series, kind: 'line', st };
  }, [chartRef]);

  /** 自訂指標參數：def 預設 ⊕ 實例覆寫 */
  const customParams = useCallback((cfg: ActiveIndicatorConfig, def: CustomIndicatorDef) => ({
    ...defaultParamsOf(def.params),
    ...cfg.params,
  }), []);

  /** 把 worker 結果掛上圖（generation 檢查防 race） */
  const applyCustomResult = useCallback((
    cfg: ActiveIndicatorConfig,
    result: CustomRunResult,
    gen: number,
  ) => {
    const chart = chartRef.current;
    if (gen !== genRef.current || !chart) return;
    const inst = instancesRef.current.get(cfg.instanceId);
    if (!inst) return;
    if (result.error) {
      console.warn(`自訂指標「${cfg.indicatorId}」執行失敗：${result.error}`);
      return;
    }

    const newNames = result.plots.map((pl) => pl.name);
    const sameShape = inst.lines.length === newNames.length
      && inst.lines.every((l, i) => l.key === newNames[i]);

    if (sameShape && inst.lines.length > 0) {
      // 形狀不變 → update 最後一點（點數相同）或 setData（點數改變,如新 K 棒）
      for (let i = 0; i < inst.lines.length; i++) {
        const line = inst.lines[i];
        const pts = result.plots[i].points;
        try {
          if (pts.length === line.lastLen && pts.length > 0) {
            updateSeriesLast(line.series, pts[pts.length - 1]);
          } else {
            setSeriesData(line.series, pts);
          }
          line.lastLen = pts.length;
        } catch {
          // series 已被移除 → 忽略
        }
      }
      return;
    }

    // 形狀改變（首次掛載 / plot 集合變動）→ 重建該實例的 plot series
    // （placeholder 不動：它佔住 pane,索引才不會因 pane 自動移除而左移）
    for (const line of inst.lines) {
      try {
        chart.removeSeries(line.series);
      } catch {
        // 已移除 → 忽略
      }
    }
    inst.lines = [];
    const needSubPane = result.plots.some((pl) => pl.pane !== 'main');
    if (needSubPane && inst.subPaneIndex === null) {
      // 重建時沒預留（def.lines 預測全主圖）→ 附加在最後
      // （index === panes.length 時 addSeries 會新建 pane,不會被 clamp 挪位）
      inst.subPaneIndex = chart.panes().length;
    }
    result.plots.forEach((pl, i) => {
      const paneIndex = pl.pane === 'main' ? 0 : (inst.subPaneIndex ?? 0);
      const created = createSeries(
        {
          color: pl.color ?? CUSTOM_FALLBACK_COLORS[i % CUSTOM_FALLBACK_COLORS.length],
          style: pl.style,
        },
        cfg,
        pl.name,
        paneIndex,
      );
      if (!created) return;
      setSeriesData(created.series, pl.points);
      inst.lines.push({
        key: pl.name,
        label: pl.name,
        series: created.series,
        kind: created.kind,
        defColor: pl.color ?? CUSTOM_FALLBACK_COLORS[i % CUSTOM_FALLBACK_COLORS.length],
        defWidth: 1,
        defStroke: 'solid',
        lastLen: pl.points.length,
      });
    });
    // hline → 掛在第一條副圖線（沒有副圖線就掛第一條線）上的 priceLine
    const anchor = inst.lines.find((_l, i) => result.plots[i]?.pane !== 'main') ?? inst.lines[0];
    if (anchor) {
      for (const hl of result.hlines) {
        try {
          anchor.series.createPriceLine({
            price: hl.value,
            color: hl.color ?? 'rgba(148, 163, 184, 0.6)',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: '',
          });
        } catch {
          // 忽略
        }
      }
    }
    applyPaneStretch();
  }, [chartRef, createSeries, applyPaneStretch]);

  /** 全部重建：結構/資料源變更時呼叫 */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    genRef.current += 1;
    const gen = genRef.current;
    teardown();

    const bars = barsRef.current ?? [];
    const settings = settingsRef.current;
    let nextSubPane = 1;

    for (const cfg of settings.active) {
      const info = resolveIndicatorInfo(cfg.indicatorId, settings.custom);
      if (!info) continue;

      if (info.kind === 'builtin' && info.builtinMeta) {
        const meta = info.builtinMeta;
        const paneIndex = meta.category === 'overlay' ? 0 : nextSubPane++;
        const results = safeCompute(meta, bars, cfg.params);
        const lines: ManagedLine[] = [];
        for (const lineDef of meta.lines) {
          const created = createSeries(lineDef, cfg, lineDef.key, paneIndex);
          if (!created) continue;
          const pts = results.find((r) => r.key === lineDef.key)?.points ?? [];
          setSeriesData(created.series, pts);
          lines.push({
            key: lineDef.key,
            label: lineDef.label,
            series: created.series,
            kind: created.kind,
            defColor: lineDef.color,
            defWidth: lineDef.lineWidth ?? 1,
            defStroke: lineDef.lineStyle ?? 'solid',
            lastLen: pts.length,
          });
        }
        instancesRef.current.set(cfg.instanceId, {
          cfg,
          isCustom: false,
          subPaneIndex: meta.category === 'overlay' ? null : paneIndex,
          placeholder: null,
          lines,
        });
      } else if (info.kind === 'custom' && info.customDef) {
        const def = info.customDef;
        // 依驗證時偵測的線預留副圖 pane（清單順序 = pane 順序）。
        // 佔位 series 同步建立把 pane 佔住——addSeries 的 paneIndex 會被
        // clamp 到當前 pane 數,異步等 worker 回來才建 pane 會亂序。
        const hasSub = def.lines.some((l) => l.pane !== 'main');
        let reserved: number | null = null;
        let placeholder: AnySeries | null = null;
        if (hasSub) {
          reserved = nextSubPane++;
          placeholder = chart.addSeries(LineSeries, {
            visible: false,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }, reserved);
        }
        instancesRef.current.set(cfg.instanceId, {
          cfg, isCustom: true, subPaneIndex: reserved, placeholder, lines: [],
        });
        const params = customParams(cfg, def);
        getWorker().run(def.code, bars, params).then((result) => {
          applyCustomResult(cfg, result, gen);
        });
      }
    }
    applyPaneStretch();
    // structureKey/barsVersion 已涵蓋 settings.active/custom 與 bars 內容變化；
    // 其餘依賴（refs / memoized callbacks）皆為穩定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, barsVersion]);

  /** 樣式/顯隱就地更新（不重建 series） */
  useEffect(() => {
    for (const cfg of settingsRef.current.active) {
      const inst = instancesRef.current.get(cfg.instanceId);
      if (!inst) continue;
      inst.cfg = cfg; // 讓 tick/legend 讀到最新顯隱與樣式
      for (const line of inst.lines) {
        const st = resolveLineStyle(
          { color: line.defColor, lineWidth: line.defWidth, lineStyle: line.defStroke },
          cfg.styles[line.key],
        );
        try {
          if (line.kind === 'histogram') {
            line.series.applyOptions({ visible: cfg.visible, color: st.color });
          } else {
            (line.series as ISeriesApi<'Line'>).applyOptions({
              visible: cfg.visible,
              color: st.color,
              lineWidth: st.lineWidth as LineWidth,
              lineStyle: STROKE_TO_LINESTYLE[st.lineStyle],
            });
          }
        } catch {
          // series 已移除 → 忽略
        }
      }
    }
    // stylesKey 已涵蓋 visible/styles 變化（此 effect 僅讀 refs）
  }, [stylesKey]);

  /** 自訂指標節流重算（tick 路徑） */
  const runCustomsThrottled = useCallback(() => {
    const settings = settingsRef.current;
    const hasCustom = settings.active.some((a) => isCustomIndicatorId(a.indicatorId));
    if (!hasCustom) return;
    const doRun = () => {
      lastCustomRunRef.current = Date.now();
      const gen = genRef.current;
      const bars = barsRef.current ?? [];
      const current = settingsRef.current;
      for (const cfg of current.active) {
        if (!isCustomIndicatorId(cfg.indicatorId)) continue;
        const def = current.custom.find((c) => c.id === cfg.indicatorId);
        if (!def) continue;
        getWorker().run(def.code, bars, customParams(cfg, def)).then((result) => {
          applyCustomResult(cfg, result, gen);
        });
      }
    };
    const elapsed = Date.now() - lastCustomRunRef.current;
    if (elapsed >= CUSTOM_TICK_THROTTLE_MS) {
      doRun();
    } else if (!customTimerRef.current) {
      customTimerRef.current = setTimeout(() => {
        customTimerRef.current = null;
        doRun();
      }, CUSTOM_TICK_THROTTLE_MS - elapsed);
    }
  }, [barsRef, getWorker, customParams, applyCustomResult]);

  /** 即時 tick：內建全量重算、只 update 最後一點（不整串 setData） */
  const onBarsTick = useCallback(() => {
    const bars = barsRef.current;
    if (!bars || bars.length === 0) return;
    const settings = settingsRef.current;
    for (const inst of instancesRef.current.values()) {
      if (inst.isCustom) continue;
      const info = resolveIndicatorInfo(inst.cfg.indicatorId, settings.custom);
      if (info?.kind !== 'builtin' || !info.builtinMeta) continue;
      const results = safeCompute(info.builtinMeta, bars, inst.cfg.params);
      for (const line of inst.lines) {
        const pts = results.find((r) => r.key === line.key)?.points;
        if (!pts || pts.length === 0) continue;
        try {
          updateSeriesLast(line.series, pts[pts.length - 1]);
          line.lastLen = pts.length;
        } catch {
          // 極端狀況（時間回捲）→ 退回全量
          try {
            setSeriesData(line.series, pts);
            line.lastLen = pts.length;
          } catch {
            // series 已移除 → 忽略
          }
        }
      }
    }
    runCustomsThrottled();
  }, [barsRef, runCustomsThrottled]);

  /** hover legend：crosshair 對到的各指標線當前值（直接寫 DOM） */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (param: MouseEventParams<Time>) => {
      const el = legendRef.current;
      if (!el) return;
      if (!param.time || param.point === undefined) {
        el.style.display = 'none';
        return;
      }
      const rows: HTMLDivElement[] = [];
      const settings = settingsRef.current;
      for (const cfg of settings.active) {
        if (!cfg.visible) continue;
        const inst = instancesRef.current.get(cfg.instanceId);
        if (!inst || inst.lines.length === 0) continue;
        const info = resolveIndicatorInfo(cfg.indicatorId, settings.custom);
        if (!info) continue;
        const paramVals = info.paramDefs.map((pd) => cfg.params[pd.key] ?? pd.default);
        const title = paramVals.length > 0 ? `${info.short}(${paramVals.join(',')})` : info.short;
        const parts: Array<{ text: string; color: string }> = [];
        for (const line of inst.lines) {
          const data = param.seriesData.get(line.series as ISeriesApi<SeriesType>) as
            | { value?: number }
            | undefined;
          const v = data?.value;
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          const st = resolveLineStyle(
            { color: line.defColor, lineWidth: line.defWidth, lineStyle: line.defStroke },
            cfg.styles[line.key],
          );
          parts.push({
            text: inst.lines.length > 1
              ? `${line.label} ${formatIndicatorValue(v)}`
              : formatIndicatorValue(v),
            color: st.color,
          });
        }
        if (parts.length === 0) continue;
        const row = document.createElement('div');
        const nameSpan = document.createElement('span');
        nameSpan.textContent = title;
        nameSpan.style.color = '#94A3B8';
        row.appendChild(nameSpan);
        for (const part of parts) {
          const span = document.createElement('span');
          span.textContent = ` ${part.text}`;
          span.style.color = part.color;
          row.appendChild(span);
        }
        rows.push(row);
      }
      if (rows.length === 0) {
        el.style.display = 'none';
        return;
      }
      el.replaceChildren(...rows);
      el.style.display = 'block';
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      try {
        chart.unsubscribeCrosshairMove(onMove);
      } catch {
        // chart 已卸載 → 忽略
      }
    };
    // chart 實例只在 mount 建立一次（ChartPanel 保證）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 卸載清理：series（chart 可能已先卸載,teardown 內已 guard）、worker、timer */
  useEffect(() => {
    return () => {
      if (customTimerRef.current) {
        clearTimeout(customTimerRef.current);
        customTimerRef.current = null;
      }
      teardown();
      workerRef.current?.dispose();
      workerRef.current = null;
    };
  }, [teardown]);

  return { onBarsTick };
}
