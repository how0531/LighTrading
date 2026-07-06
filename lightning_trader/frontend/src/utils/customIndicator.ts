/**
 * customIndicator.ts — 自訂 JS 指標的執行 harness（Sprint E）
 *
 * runUserIndicator(code, candles, params) 為「純函式」：
 *   - 以 new Function 包裝使用者代碼，注入 candles / params / ta.* / plot / hline
 *     與 close/open/high/low/volume/time 等長陣列。
 *   - 蒐集 plot()/hline() 呼叫 → 輸出線自動偵測。
 *   - throw → {error, errorLine?}，不外拋。
 *
 * 沙箱分層：
 *   1. 真正的隔離在 workers/indicatorWorker.ts（獨立執行緒、全域網路/儲存
 *      能力清空、主執行緒 2s timeout → terminate）。
 *   2. 本 harness 另以函式作用域 var 遮蔽（fetch/XMLHttpRequest/WebSocket/
 *      importScripts/indexedDB/...）做 defense-in-depth——即使在主執行緒
 *      跑測試，使用者代碼也拿不到這些全域。
 * 絕不在主執行緒 eval 使用者代碼（僅測試 harness 純邏輯時例外）。
 */
import {
  type Candle,
  type IndicatorPoint,
  alignedSMA,
  alignedEMA,
  alignedWMA,
  alignedRSI,
  alignedStdev,
  alignedHighest,
  alignedLowest,
  alignedChange,
  alignedROC,
  alignedCrossover,
  alignedCrossunder,
  alignedTR,
  alignedATRFromBars,
} from './indicators';
import type { IndicatorParamDef } from './indicatorRegistry';

export interface CustomPlot {
  name: string;
  points: IndicatorPoint[];
  style: 'line' | 'histogram';
  pane: 'main' | 'sub';
  color?: string;
}

export interface CustomHLine {
  value: number;
  color?: string;
}

export interface CustomRunResult {
  plots: CustomPlot[];
  hlines: CustomHLine[];
  error?: string;
  /** 錯誤行號 hint（使用者代碼的 1-based 行號；不一定可得） */
  errorLine?: number;
}

/** 注入使用者代碼的 ta 工具集（委派 utils/indicators 純函式） */
export interface TaToolkit {
  sma: (src: number[], period: number) => number[];
  ema: (src: number[], period: number) => number[];
  wma: (src: number[], period: number) => number[];
  rsi: (src: number[], period: number) => number[];
  stdev: (src: number[], period: number) => number[];
  highest: (src: number[], period: number) => number[];
  lowest: (src: number[], period: number) => number[];
  change: (src: number[], n?: number) => number[];
  roc: (src: number[], n: number) => number[];
  crossover: (a: number[], b: number[]) => boolean[];
  crossunder: (a: number[], b: number[]) => boolean[];
  /** ATR 綁定當前 candles：ta.atr(14) */
  atr: (period: number) => number[];
  /** True Range 序列（綁定當前 candles） */
  tr: () => number[];
}

export function makeTa(candles: Candle[]): TaToolkit {
  return {
    sma: alignedSMA,
    ema: alignedEMA,
    wma: alignedWMA,
    rsi: alignedRSI,
    stdev: alignedStdev,
    highest: alignedHighest,
    lowest: alignedLowest,
    change: alignedChange,
    roc: alignedROC,
    crossover: alignedCrossover,
    crossunder: alignedCrossunder,
    atr: (period: number) => alignedATRFromBars(candles, period),
    tr: () => alignedTR(candles),
  };
}

/**
 * 參數宣告註解：`//@param key 預設 [最小] [最大] [中文標籤]`
 * 例：`//@param period 14 1 200 週期`
 * 省略範圍時給寬鬆界線（±1,000,000）。重複 key 以第一次為準。
 */
export function parseParamComments(code: string): IndicatorParamDef[] {
  const out: IndicatorParamDef[] = [];
  const seen = new Set<string>();
  const re = /^\s*\/\/\s*@param\s+([A-Za-z_$][\w$]*)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?(?:\s+(-?\d+(?:\.\d+)?))?(?:\s+(\S.*?))?\s*$/;
  for (const line of code.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const def = Number(m[2]);
    let min = m[3] !== undefined ? Number(m[3]) : -1_000_000;
    let max = m[4] !== undefined ? Number(m[4]) : 1_000_000;
    if (min > max) [min, max] = [max, min];
    out.push({
      key,
      label: m[5]?.trim() || key,
      default: Math.min(max, Math.max(min, def)),
      min,
      max,
    });
  }
  return out;
}

/** 使用者代碼的具名參數（同時是 sandbox 白名單的正面表列） */
const ARG_NAMES = [
  'candles', 'params', 'ta', 'plot', 'hline',
  'close', 'open', 'high', 'low', 'volume', 'time',
] as const;

/**
 * 遮蔽危險全域（函式作用域 var → 覆蓋為 undefined）。
 * 這是 defense-in-depth：worker 端已把全域清空，這裡再擋一層，
 * 讓主執行緒測試環境下的行為與 worker 一致。
 */
const SANDBOX_SHADOW =
  'var fetch, XMLHttpRequest, WebSocket, EventSource, importScripts, indexedDB, ' +
  'localStorage, sessionStorage, caches, cookieStore, ' +
  'globalThis, self, window, document, navigator, location, ' +
  'postMessage, onmessage, close;';

const PRELUDE = `"use strict";\n${SANDBOX_SHADOW}\n`;
// new Function 產生的原始碼在 body 前有 2 行（function anonymous(args\n) {\n）
const LINE_OFFSET = 2 + (PRELUDE.match(/\n/g)?.length ?? 0);

function extractErrorLine(err: unknown): number | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  // V8: "at eval (eval at ...)" / "<anonymous>:LINE:COL"；Firefox: "> Function:LINE:COL"
  const m = /<anonymous>:(\d+):\d+/.exec(err.stack) ?? /Function:(\d+):\d+/.exec(err.stack);
  if (!m) return undefined;
  const line = Number(m[1]) - LINE_OFFSET;
  return line >= 1 ? line : undefined;
}

function toPoints(candles: Candle[], values: unknown[], plotName: string): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  // 判別模式：{time, value} 物件陣列 vs 與 candles 對齊的數值陣列
  const firstObj = values.find((v) => v !== null && v !== undefined);
  if (firstObj !== undefined && typeof firstObj === 'object') {
    for (const v of values) {
      if (!v || typeof v !== 'object') continue;
      const rec = v as Record<string, unknown>;
      const t = rec.time;
      const val = rec.value;
      if (typeof t === 'number' && typeof val === 'number' && Number.isFinite(val)) {
        out.push({ time: t, value: val });
      }
    }
    return out;
  }
  const n = Math.min(candles.length, values.length);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out.push({ time: candles[i].time, value: v });
  }
  if (values.length > candles.length) {
    throw new Error(`plot("${plotName}")：數列長度 ${values.length} 超過 K 棒數 ${candles.length}（需與 candles 等長對齊）`);
  }
  return out;
}

/**
 * 執行使用者指標代碼（純函式，不外拋）。
 * 成功：{plots, hlines}；失敗：{plots:[], hlines:[], error, errorLine?}
 */
export function runUserIndicator(
  code: string,
  candles: Candle[],
  params: Record<string, number>,
): CustomRunResult {
  const plots: CustomPlot[] = [];
  const hlines: CustomHLine[] = [];
  const usedNames = new Set<string>();

  const plot = (name: unknown, values: unknown, opts?: unknown): void => {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('plot(name, values)：name 必須是非空字串');
    }
    if (!Array.isArray(values)) {
      throw new Error(`plot("${name}")：values 必須是陣列（與 candles 等長的數值陣列,或 {time, value} 陣列）`);
    }
    const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
    // 重名自動加尾碼，避免蓋掉前一條
    let finalName = name.trim();
    let suffix = 2;
    while (usedNames.has(finalName)) finalName = `${name.trim()}_${suffix++}`;
    usedNames.add(finalName);
    plots.push({
      name: finalName,
      points: toPoints(candles, values, finalName),
      style: o.style === 'histogram' ? 'histogram' : 'line',
      pane: o.pane === 'main' ? 'main' : 'sub',
      ...(typeof o.color === 'string' && o.color ? { color: o.color } : {}),
    });
  };

  const hline = (value: unknown, opts?: unknown): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('hline(value)：value 必須是有限數字');
    }
    const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>;
    hlines.push({
      value,
      ...(typeof o.color === 'string' && o.color ? { color: o.color } : {}),
    });
  };

  const ta = makeTa(candles);
  const closes = candles.map((c) => c.close);
  const opens = candles.map((c) => c.open);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const times = candles.map((c) => c.time);

  try {
    // new Function：只在 worker 內執行（見檔頭沙箱分層說明）;測試環境例外
    const fn = new Function(...ARG_NAMES, PRELUDE + code) as (
      ...args: unknown[]
    ) => unknown;
    fn(candles, params, ta, plot, hline, closes, opens, highs, lows, volumes, times);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const errorLine = extractErrorLine(err);
    return { plots: [], hlines: [], error: message, ...(errorLine ? { errorLine } : {}) };
  }
  return { plots, hlines };
}

/** 驗證/預覽用：合成 K 棒（sin 波動 + 遞增量），當圖表尚無資料時使用 */
export function syntheticCandles(count: number = 120): Candle[] {
  const out: Candle[] = [];
  let close = 100;
  for (let i = 0; i < count; i++) {
    const open = close;
    close = 100 + Math.sin(i / 7) * 8 + Math.sin(i / 23) * 4;
    const high = Math.max(open, close) + 1.5;
    const low = Math.min(open, close) - 1.5;
    out.push({ time: 1_700_000_000 + i * 60, open, high, low, close, volume: 100 + (i % 10) * 20 });
  }
  return out;
}
