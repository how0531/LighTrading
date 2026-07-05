/**
 * indicatorRegistry.ts — 內建技術指標的集中註冊表（Sprint E）
 *
 * 每種指標：id、中文名、類別（主圖 overlay / 副圖 pane）、參數 schema
 * （名稱/預設/範圍）、輸出線定義（key/名稱/預設色/線型），以及 compute 接線。
 * IndicatorPicker、useIndicators、自訂指標 harness 都以此為單一事實來源。
 */
import {
  type Candle,
  type IndicatorPoint,
  computeSMA,
  computeEMA,
  computeBollinger,
  computeRSI,
  computeWMA,
  computeDonchian,
  computeKeltner,
  computePSAR,
  computeSuperTrend,
  computeVWAPDaily,
  computeEnvelope,
  computeMACD,
  computeKD,
  computeATR,
  computeCCI,
  computeOBV,
  computeWilliamsR,
  computeMFI,
  computeROC,
  computeDMI,
  computeVolumeMA,
} from './indicators';

export type IndicatorCategory = 'overlay' | 'pane';
export type LineRenderStyle = 'line' | 'histogram';
export type LineStrokeStyle = 'solid' | 'dashed' | 'dotted';

/** 參數 schema：動態表單用（數字 input 附範圍） */
export interface IndicatorParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
}

/** 輸出線定義：key 對應 compute 結果、預設樣式 */
export interface IndicatorLineDef {
  key: string;
  label: string;
  color: string;
  style: LineRenderStyle;
  lineWidth?: 1 | 2 | 3;
  lineStyle?: LineStrokeStyle;
  /** 成交量類 → lightweight-charts priceFormat: volume */
  format?: 'volume';
}

/** compute 統一輸出：每條線一組點列，key 對應 lines 定義 */
export interface IndicatorSeriesResult {
  key: string;
  points: IndicatorPoint[];
}

export interface IndicatorMeta {
  id: string;
  /** 中文名（搜尋/清單顯示） */
  name: string;
  /** legend 短代號，如 SMA、MACD */
  short: string;
  category: IndicatorCategory;
  params: IndicatorParamDef[];
  lines: IndicatorLineDef[];
  compute: (bars: Candle[], params: Record<string, number>) => IndicatorSeriesResult[];
}

const p = (
  key: string, label: string, def: number, min: number, max: number, step?: number,
): IndicatorParamDef => ({ key, label, default: def, min, max, ...(step ? { step } : {}) });

// 把 {time,value}[]（舊版函式輸出）視為 IndicatorPoint[]（結構相容）
const asPts = (arr: Array<{ time: number; value: number }>): IndicatorPoint[] => arr;

export const INDICATOR_REGISTRY: IndicatorMeta[] = [
  /* ── 主圖 overlay（10） ─────────────────────────────── */
  {
    id: 'sma',
    name: '簡單移動平均線 SMA',
    short: 'SMA',
    category: 'overlay',
    params: [p('period', '週期', 20, 1, 500)],
    lines: [{ key: 'sma', label: 'SMA', color: '#60a5fa', style: 'line' }],
    compute: (bars, prm) => [{ key: 'sma', points: asPts(computeSMA(bars, prm.period)) }],
  },
  {
    id: 'ema',
    name: '指數移動平均線 EMA',
    short: 'EMA',
    category: 'overlay',
    params: [p('period', '週期', 20, 1, 500)],
    lines: [{ key: 'ema', label: 'EMA', color: '#fb923c', style: 'line' }],
    compute: (bars, prm) => [{ key: 'ema', points: asPts(computeEMA(bars, prm.period)) }],
  },
  {
    id: 'wma',
    name: '加權移動平均線 WMA',
    short: 'WMA',
    category: 'overlay',
    params: [p('period', '週期', 20, 1, 500)],
    lines: [{ key: 'wma', label: 'WMA', color: '#e879f9', style: 'line' }],
    compute: (bars, prm) => [{ key: 'wma', points: computeWMA(bars, prm.period) }],
  },
  {
    id: 'bbands',
    name: '布林通道 BBands',
    short: 'BOLL',
    category: 'overlay',
    params: [p('period', '週期', 20, 2, 500), p('mult', '標準差倍數', 2, 0.5, 5, 0.1)],
    lines: [
      { key: 'mid', label: '中軌', color: 'rgba(34, 211, 238, 0.45)', style: 'line', lineStyle: 'dashed' },
      { key: 'upper', label: '上軌', color: 'rgba(34, 211, 238, 0.8)', style: 'line' },
      { key: 'lower', label: '下軌', color: 'rgba(34, 211, 238, 0.8)', style: 'line' },
    ],
    compute: (bars, prm) => {
      const b = computeBollinger(bars, prm.period, prm.mult);
      return [
        { key: 'mid', points: asPts(b.middle) },
        { key: 'upper', points: asPts(b.upper) },
        { key: 'lower', points: asPts(b.lower) },
      ];
    },
  },
  {
    id: 'donchian',
    name: '唐奇安通道 Donchian',
    short: 'DC',
    category: 'overlay',
    params: [p('period', '週期', 20, 1, 500)],
    lines: [
      { key: 'upper', label: '上軌', color: '#f59e0b', style: 'line' },
      { key: 'mid', label: '中軌', color: 'rgba(245, 158, 11, 0.5)', style: 'line', lineStyle: 'dashed' },
      { key: 'lower', label: '下軌', color: '#f59e0b', style: 'line' },
    ],
    compute: (bars, prm) => {
      const d = computeDonchian(bars, prm.period);
      return [
        { key: 'upper', points: d.upper },
        { key: 'mid', points: d.middle },
        { key: 'lower', points: d.lower },
      ];
    },
  },
  {
    id: 'keltner',
    name: '肯特納通道 Keltner',
    short: 'KC',
    category: 'overlay',
    params: [
      p('period', 'EMA 週期', 20, 2, 500),
      p('atrPeriod', 'ATR 週期', 10, 1, 200),
      p('mult', 'ATR 倍數', 2, 0.5, 5, 0.1),
    ],
    lines: [
      { key: 'mid', label: '中軌', color: 'rgba(163, 230, 53, 0.5)', style: 'line', lineStyle: 'dashed' },
      { key: 'upper', label: '上軌', color: '#a3e635', style: 'line' },
      { key: 'lower', label: '下軌', color: '#a3e635', style: 'line' },
    ],
    compute: (bars, prm) => {
      const kc = computeKeltner(bars, prm.period, prm.atrPeriod, prm.mult);
      return [
        { key: 'mid', points: kc.middle },
        { key: 'upper', points: kc.upper },
        { key: 'lower', points: kc.lower },
      ];
    },
  },
  {
    id: 'psar',
    name: '拋物線 SAR',
    short: 'SAR',
    category: 'overlay',
    params: [p('step', '加速因子', 0.02, 0.001, 0.2, 0.001), p('maxAf', '加速上限', 0.2, 0.02, 1, 0.01)],
    lines: [{ key: 'sar', label: 'SAR', color: '#facc15', style: 'line', lineStyle: 'dotted' }],
    compute: (bars, prm) => [{ key: 'sar', points: computePSAR(bars, prm.step, prm.maxAf) }],
  },
  {
    id: 'supertrend',
    name: '超級趨勢 SuperTrend',
    short: 'ST',
    category: 'overlay',
    params: [p('period', 'ATR 週期', 10, 1, 200), p('mult', 'ATR 倍數', 3, 0.5, 10, 0.1)],
    lines: [{ key: 'st', label: 'SuperTrend', color: '#EF4444', style: 'line', lineWidth: 2 }],
    compute: (bars, prm) => [{ key: 'st', points: computeSuperTrend(bars, prm.period, prm.mult) }],
  },
  {
    id: 'vwap',
    name: '成交量加權均價 VWAP（日內）',
    short: 'VWAP',
    category: 'overlay',
    params: [],
    lines: [{ key: 'vwap', label: 'VWAP', color: '#D4AF37', style: 'line' }],
    compute: (bars) => [{ key: 'vwap', points: computeVWAPDaily(bars) }],
  },
  {
    id: 'envelope',
    name: '價格包絡 Envelope',
    short: 'ENV',
    category: 'overlay',
    params: [p('period', '週期', 20, 1, 500), p('pct', '包絡 %', 2.5, 0.1, 20, 0.1)],
    lines: [
      { key: 'mid', label: '中線', color: 'rgba(148, 163, 184, 0.5)', style: 'line', lineStyle: 'dashed' },
      { key: 'upper', label: '上緣', color: '#94a3b8', style: 'line' },
      { key: 'lower', label: '下緣', color: '#94a3b8', style: 'line' },
    ],
    compute: (bars, prm) => {
      const e = computeEnvelope(bars, prm.period, prm.pct);
      return [
        { key: 'mid', points: e.middle },
        { key: 'upper', points: e.upper },
        { key: 'lower', points: e.lower },
      ];
    },
  },

  /* ── 副圖 pane（11） ────────────────────────────────── */
  {
    id: 'macd',
    name: 'MACD 指數平滑異同',
    short: 'MACD',
    category: 'pane',
    params: [
      p('fast', '快線週期', 12, 1, 200),
      p('slow', '慢線週期', 26, 2, 300),
      p('signal', '訊號週期', 9, 1, 100),
    ],
    lines: [
      { key: 'osc', label: 'OSC', color: 'rgba(148, 163, 184, 0.5)', style: 'histogram' },
      { key: 'dif', label: 'DIF', color: '#60a5fa', style: 'line' },
      { key: 'dea', label: 'DEA', color: '#fb923c', style: 'line' },
    ],
    compute: (bars, prm) => {
      const m = computeMACD(bars, prm.fast, prm.slow, prm.signal);
      return [
        { key: 'osc', points: m.hist },
        { key: 'dif', points: m.dif },
        { key: 'dea', points: m.dea },
      ];
    },
  },
  {
    id: 'rsi',
    name: 'RSI 相對強弱指標',
    short: 'RSI',
    category: 'pane',
    params: [p('period', '週期', 14, 2, 200)],
    lines: [{ key: 'rsi', label: 'RSI', color: '#fb7185', style: 'line' }],
    compute: (bars, prm) => [{ key: 'rsi', points: asPts(computeRSI(bars, prm.period)) }],
  },
  {
    id: 'kd',
    name: 'KD 隨機指標',
    short: 'KD',
    category: 'pane',
    params: [
      p('period', 'RSV 週期', 9, 1, 200),
      p('kSmooth', 'K 平滑', 3, 1, 50),
      p('dSmooth', 'D 平滑', 3, 1, 50),
    ],
    lines: [
      { key: 'k', label: '%K', color: '#60a5fa', style: 'line' },
      { key: 'd', label: '%D', color: '#fb923c', style: 'line' },
    ],
    compute: (bars, prm) => {
      const kd = computeKD(bars, prm.period, prm.kSmooth, prm.dSmooth);
      return [
        { key: 'k', points: kd.k },
        { key: 'd', points: kd.d },
      ];
    },
  },
  {
    id: 'atr',
    name: 'ATR 平均真實區間',
    short: 'ATR',
    category: 'pane',
    params: [p('period', '週期', 14, 1, 200)],
    lines: [{ key: 'atr', label: 'ATR', color: '#22d3ee', style: 'line' }],
    compute: (bars, prm) => [{ key: 'atr', points: computeATR(bars, prm.period) }],
  },
  {
    id: 'cci',
    name: 'CCI 順勢指標',
    short: 'CCI',
    category: 'pane',
    params: [p('period', '週期', 20, 2, 200)],
    lines: [{ key: 'cci', label: 'CCI', color: '#c084fc', style: 'line' }],
    compute: (bars, prm) => [{ key: 'cci', points: computeCCI(bars, prm.period) }],
  },
  {
    id: 'obv',
    name: 'OBV 能量潮',
    short: 'OBV',
    category: 'pane',
    params: [],
    lines: [{ key: 'obv', label: 'OBV', color: '#34d399', style: 'line', format: 'volume' }],
    compute: (bars) => [{ key: 'obv', points: computeOBV(bars) }],
  },
  {
    id: 'willr',
    name: '威廉指標 %R',
    short: 'W%R',
    category: 'pane',
    params: [p('period', '週期', 14, 1, 200)],
    lines: [{ key: 'willr', label: '%R', color: '#f472b6', style: 'line' }],
    compute: (bars, prm) => [{ key: 'willr', points: computeWilliamsR(bars, prm.period) }],
  },
  {
    id: 'mfi',
    name: 'MFI 資金流量指標',
    short: 'MFI',
    category: 'pane',
    params: [p('period', '週期', 14, 1, 200)],
    lines: [{ key: 'mfi', label: 'MFI', color: '#4ade80', style: 'line' }],
    compute: (bars, prm) => [{ key: 'mfi', points: computeMFI(bars, prm.period) }],
  },
  {
    id: 'roc',
    name: 'ROC 動量變動率',
    short: 'ROC',
    category: 'pane',
    params: [p('period', '週期', 12, 1, 200)],
    lines: [{ key: 'roc', label: 'ROC', color: '#38bdf8', style: 'line' }],
    compute: (bars, prm) => [{ key: 'roc', points: computeROC(bars, prm.period) }],
  },
  {
    id: 'dmi',
    name: 'DMI 趨向指標（ADX）',
    short: 'DMI',
    category: 'pane',
    params: [p('period', 'DI 週期', 14, 1, 200), p('adxPeriod', 'ADX 週期', 14, 1, 200)],
    lines: [
      { key: 'pdi', label: '+DI', color: '#EF4444', style: 'line' },
      { key: 'mdi', label: '-DI', color: '#10B981', style: 'line' },
      { key: 'adx', label: 'ADX', color: '#D4AF37', style: 'line', lineWidth: 2 },
    ],
    compute: (bars, prm) => {
      const d = computeDMI(bars, prm.period, prm.adxPeriod);
      return [
        { key: 'pdi', points: d.plusDI },
        { key: 'mdi', points: d.minusDI },
        { key: 'adx', points: d.adx },
      ];
    },
  },
  {
    id: 'vol',
    name: '成交量（含量均線）',
    short: 'VOL',
    category: 'pane',
    params: [p('maPeriod', '量均週期', 5, 1, 200)],
    lines: [
      { key: 'vol', label: '量', color: 'rgba(212, 175, 55, 0.4)', style: 'histogram', format: 'volume' },
      { key: 'volma', label: '量均', color: '#f8fafc', style: 'line', format: 'volume' },
    ],
    compute: (bars, prm) => {
      const v = computeVolumeMA(bars, prm.maPeriod);
      return [
        { key: 'vol', points: v.volume },
        { key: 'volma', points: v.volMA },
      ];
    },
  },
];

const REGISTRY_BY_ID = new Map(INDICATOR_REGISTRY.map((m) => [m.id, m]));

export function getIndicatorMeta(id: string): IndicatorMeta | undefined {
  return REGISTRY_BY_ID.get(id);
}

/** 依 schema 產生預設參數物件 */
export function defaultParamsOf(defs: IndicatorParamDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of defs) out[d.key] = d.default;
  return out;
}

/** 把參數 clamp 進 schema 範圍；未知 key 丟棄、缺漏補預設 */
export function sanitizeParams(defs: IndicatorParamDef[], raw: unknown): Record<string, number> {
  const out = defaultParamsOf(defs);
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    for (const d of defs) {
      const v = rec[d.key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[d.key] = Math.min(d.max, Math.max(d.min, v));
      }
    }
  }
  return out;
}

/** compute 安全包裝：任何 throw → 空結果（圖表不因單一指標壞掉而崩） */
export function safeCompute(
  meta: IndicatorMeta, bars: Candle[], params: Record<string, number>,
): IndicatorSeriesResult[] {
  try {
    return meta.compute(bars, sanitizeParams(meta.params, params));
  } catch {
    return meta.lines.map((l) => ({ key: l.key, points: [] }));
  }
}
