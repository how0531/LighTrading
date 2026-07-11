/**
 * indicators.ts — 圖表指標的純函式
 *
 * 抽出來方便獨立測試。Time 維度用 unix 秒（lightweight-charts Time）。
 */

interface BarLite {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function computeSMA(bars: BarLite[], period: number): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  if (period <= 0 || bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) {
      out.push({ time: bars[i].time, value: sum / period });
    }
  }
  return out;
}

export function computeVWAP(bars: BarLite[]): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  let cumPV = 0;
  let cumV = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    cumPV += tp * b.volume;
    cumV += b.volume;
    if (cumV > 0) {
      out.push({ time: b.time, value: cumPV / cumV });
    }
  }
  return out;
}

/**
 * 指數移動平均 EMA（Sprint 34）
 *
 * 乘數 k = 2 / (period + 1)，遞迴公式：
 *   ema = close * k + prev_ema * (1 - k)
 * 前 `period` 根用簡單平均（SMA）初始化，於 index = period - 1
 * 輸出第一個值（與 computeSMA 的輸出起點對齊）。
 *
 * 邊界行為：period <= 0 或 bars 不足 period 根時回空陣列。
 */
export function computeEMA(bars: BarLite[], period: number): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  if (period <= 0 || bars.length < period) return out;

  // 前 period 根的 SMA 作為初始 EMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].close;
  let ema = sum / period;
  out.push({ time: bars[period - 1].time, value: ema });

  const k = 2 / (period + 1);
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    out.push({ time: bars[i].time, value: ema });
  }
  return out;
}

/**
 * 布林通道 Bollinger Bands（Sprint 34）
 *
 * middle = SMA(period)；
 * σ 採「母體標準差」（除以 N，不是 N-1），與多數看盤軟體一致；
 * upper / lower = middle ± mult × σ。
 *
 * 預設 period = 20、mult = 2。三條陣列等長且 time 對齊，
 * 起點與 computeSMA 相同（index = period - 1）。
 *
 * 邊界行為：period <= 0 或 bars 不足 period 根時回三條空陣列。
 */
export function computeBollinger(bars: BarLite[], period: number = 20, mult: number = 2): {
  upper: Array<{ time: number; value: number }>;
  middle: Array<{ time: number; value: number }>;
  lower: Array<{ time: number; value: number }>;
} {
  const upper: Array<{ time: number; value: number }> = [];
  const middle: Array<{ time: number; value: number }> = [];
  const lower: Array<{ time: number; value: number }> = [];
  if (period <= 0 || bars.length < period) return { upper, middle, lower };

  for (let i = period - 1; i < bars.length; i++) {
    // 視窗 [i - period + 1, i] 的平均
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
    const mean = sum / period;
    // 母體變異數（除以 N）
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = bars[j].close - mean;
      sqSum += d * d;
    }
    const sigma = Math.sqrt(sqSum / period);
    const t = bars[i].time;
    middle.push({ time: t, value: mean });
    upper.push({ time: t, value: mean + mult * sigma });
    lower.push({ time: t, value: mean - mult * sigma });
  }
  return { upper, middle, lower };
}

/**
 * Wilder's RSI（Sprint 25）
 *
 * 計算每根 bar 的 close 與前一根 close 的差，分為 gain / loss。
 * 前 `period` 根用簡單平均（SMA）初始化；之後用 Wilder smoothing
 *   avg_gain = (prev_avg_gain * (period-1) + cur_gain) / period
 * RSI = 100 - 100/(1+RS)，RS = avg_gain / avg_loss。
 *
 * 多數平台預設 period = 14。
 */
export function computeRSI(bars: BarLite[], period: number = 14): Array<{ time: number; value: number }> {
  const out: Array<{ time: number; value: number }> = [];
  if (period <= 0 || bars.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  // 累積前 `period` 根 (index 1..period) 的 gain / loss
  for (let i = 1; i <= period; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    if (diff >= 0) gainSum += diff; else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  // 第 period 根輸出第一個 RSI
  out.push({ time: bars[period].time, value: rsiValue(avgGain, avgLoss) });

  for (let i = period + 1; i < bars.length; i++) {
    const diff = bars[i].close - bars[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push({ time: bars[i].time, value: rsiValue(avgGain, avgLoss) });
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/* ════════════════════════════════════════════════════════════════════
 * Sprint E：指標系統擴充
 *
 * 兩層結構：
 *   1. aligned-array 核心（ta 層）：輸入/輸出皆為「與 K 棒等長」的 number[]，
 *      暖身期以 NaN 填充。方便串接（ema(rsi(...)) 之類）與自訂 JS 指標使用。
 *   2. computeXXX 指標函式：輸出 {time, value, color?} 點列（NaN 自動略過），
 *      直接餵給 lightweight-charts。
 *
 * 舊版 computeSMA/computeVWAP/computeRSI/computeEMA/computeBollinger 保留
 * （既有測試 + golden 基準）；新系統可重用之。
 * ════════════════════════════════════════════════════════════════════ */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 指標輸出點。color 為選填的逐點顏色（histogram 紅綠、SuperTrend 翻轉等） */
export interface IndicatorPoint {
  time: number;
  value: number;
  color?: string;
}

/** 台灣配色：紅 = 多/漲、綠 = 空/跌（與 ChartPanel K 棒一致） */
export const TREND_UP_COLOR = '#EF4444';
export const TREND_DOWN_COLOR = '#10B981';
const HIST_UP_COLOR = 'rgba(239, 68, 68, 0.55)';
const HIST_DOWN_COLOR = 'rgba(16, 185, 129, 0.55)';
const VOL_UP_COLOR = 'rgba(239, 68, 68, 0.4)';
const VOL_DOWN_COLOR = 'rgba(16, 185, 129, 0.4)';

/** aligned number[] → 點列（NaN / ±Infinity 略過） */
export function pointsFromAligned(
  bars: Candle[], values: number[], colors?: Array<string | undefined>,
): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  const n = Math.min(bars.length, values.length);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const c = colors?.[i];
    out.push(c ? { time: bars[i].time, value: v, color: c } : { time: bars[i].time, value: v });
  }
  return out;
}

/* ── aligned-array 核心（ta 層） ───────────────────────────────── */

/** 簡單移動平均。視窗含 NaN → 該點 NaN。 */
export function alignedSMA(src: number[], period: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || !Number.isInteger(period)) return out;
  let sum = 0;
  let nanCount = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (Number.isFinite(v)) sum += v; else nanCount++;
    if (i >= period) {
      const old = src[i - period];
      if (Number.isFinite(old)) sum -= old; else nanCount--;
    }
    if (i >= period - 1 && nanCount === 0) out[i] = sum / period;
  }
  return out;
}

/** 指數移動平均。前緣 NaN 自動跳過（以其後第一段連續 period 根 SMA 起種）。 */
export function alignedEMA(src: number[], period: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || !Number.isInteger(period)) return out;
  const k = 2 / (period + 1);
  let ema = NaN;
  let run = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) {
      // 尚未起種 → 重置累計；已起種 → 維持狀態、該點輸出 NaN
      if (!Number.isFinite(ema)) { run = 0; sum = 0; }
      continue;
    }
    if (Number.isFinite(ema)) {
      ema = v * k + ema * (1 - k);
      out[i] = ema;
    } else {
      run++;
      sum += v;
      if (run === period) {
        ema = sum / period;
        out[i] = ema;
      }
    }
  }
  return out;
}

/** 線性加權移動平均（最近權重最大：1..period）。 */
export function alignedWMA(src: number[], period: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || !Number.isInteger(period)) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let acc = 0;
    let ok = true;
    for (let j = 0; j < period; j++) {
      const v = src[i - period + 1 + j];
      if (!Number.isFinite(v)) { ok = false; break; }
      acc += v * (j + 1);
    }
    if (ok) out[i] = acc / denom;
  }
  return out;
}

/** 母體標準差（除以 N，與 computeBollinger 一致）。 */
export function alignedStdev(src: number[], period: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || !Number.isInteger(period)) return out;
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (!Number.isFinite(src[j])) { ok = false; break; }
      sum += src[j];
    }
    if (!ok) continue;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = src[j] - mean;
      sq += d * d;
    }
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

/** 視窗最高值。 */
export function alignedHighest(src: number[], period: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || !Number.isInteger(period)) return out;
  for (let i = period - 1; i < n; i++) {
    let m = -Infinity;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = src[j];
      if (!Number.isFinite(v)) { ok = false; break; }
      if (v > m) m = v;
    }
    if (ok) out[i] = m;
  }
  return out;
}

/** 視窗最低值。 */
export function alignedLowest(src: number[], period: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || !Number.isInteger(period)) return out;
  for (let i = period - 1; i < n; i++) {
    let m = Infinity;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = src[j];
      if (!Number.isFinite(v)) { ok = false; break; }
      if (v < m) m = v;
    }
    if (ok) out[i] = m;
  }
  return out;
}

/** 差分：src[i] - src[i-n]。 */
export function alignedChange(src: number[], n: number = 1): number[] {
  const len = src.length;
  const out = new Array<number>(len).fill(NaN);
  if (n <= 0 || !Number.isInteger(n)) return out;
  for (let i = n; i < len; i++) {
    const a = src[i];
    const b = src[i - n];
    if (Number.isFinite(a) && Number.isFinite(b)) out[i] = a - b;
  }
  return out;
}

/** 變動率 %：(src[i]/src[i-n] - 1) × 100。分母 0 → NaN。 */
export function alignedROC(src: number[], n: number): number[] {
  const len = src.length;
  const out = new Array<number>(len).fill(NaN);
  if (n <= 0 || !Number.isInteger(n)) return out;
  for (let i = n; i < len; i++) {
    const a = src[i];
    const b = src[i - n];
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) out[i] = (a / b - 1) * 100;
  }
  return out;
}

/** Wilder RSI（aligned 版；有限輸入時與 computeRSI 數值一致）。 */
export function alignedRSI(src: number[], period: number): number[] {
  const n = src.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || !Number.isInteger(period)) return out;
  let avgG = NaN;
  let avgL = NaN;
  let prev = NaN;
  let run = 0;
  let gSum = 0;
  let lSum = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) {
      if (!Number.isFinite(avgG)) { run = 0; gSum = 0; lSum = 0; prev = NaN; }
      continue;
    }
    if (!Number.isFinite(prev)) { prev = v; continue; }
    const diff = v - prev;
    prev = v;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    if (Number.isFinite(avgG)) {
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i] = rsiValue(avgG, avgL);
    } else {
      run++;
      gSum += g;
      lSum += l;
      if (run === period) {
        avgG = gSum / period;
        avgL = lSum / period;
        out[i] = rsiValue(avgG, avgL);
      }
    }
  }
  return out;
}

/** True Range（第一根 = high-low）。 */
export function alignedTR(bars: Candle[]): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (i === 0) {
      out[i] = b.high - b.low;
    } else {
      const pc = bars[i - 1].close;
      out[i] = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
  }
  return out;
}

/** Wilder ATR：前 period 根 TR 簡單平均起種（index = period-1），之後 Wilder smoothing。 */
export function alignedATRFromBars(bars: Candle[], period: number): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(NaN);
  if (period <= 0 || !Number.isInteger(period) || n < period) return out;
  const tr = alignedTR(bars);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let atr = sum / period;
  out[period - 1] = atr;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** a 上穿 b：a[i-1] <= b[i-1] 且 a[i] > b[i]（四值皆有限）。 */
export function alignedCrossover(a: number[], b: number[]): boolean[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i]) && Number.isFinite(a[i - 1]) && Number.isFinite(b[i - 1])) {
      out[i] = a[i - 1] <= b[i - 1] && a[i] > b[i];
    }
  }
  return out;
}

/** a 下穿 b。 */
export function alignedCrossunder(a: number[], b: number[]): boolean[] {
  const n = Math.min(a.length, b.length);
  const out = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i]) && Number.isFinite(a[i - 1]) && Number.isFinite(b[i - 1])) {
      out[i] = a[i - 1] >= b[i - 1] && a[i] < b[i];
    }
  }
  return out;
}

/* ── 主圖 overlay 指標 ─────────────────────────────────────────── */

/** 加權移動平均 WMA。 */
export function computeWMA(bars: Candle[], period: number): IndicatorPoint[] {
  return pointsFromAligned(bars, alignedWMA(bars.map((b) => b.close), period));
}

/** 唐奇安通道：upper = 視窗最高 high、lower = 視窗最低 low、middle = 兩者均值。 */
export function computeDonchian(bars: Candle[], period: number): {
  upper: IndicatorPoint[]; middle: IndicatorPoint[]; lower: IndicatorPoint[];
} {
  const hi = alignedHighest(bars.map((b) => b.high), period);
  const lo = alignedLowest(bars.map((b) => b.low), period);
  const mid = hi.map((h, i) => (Number.isFinite(h) && Number.isFinite(lo[i]) ? (h + lo[i]) / 2 : NaN));
  return {
    upper: pointsFromAligned(bars, hi),
    middle: pointsFromAligned(bars, mid),
    lower: pointsFromAligned(bars, lo),
  };
}

/** 肯特納通道：middle = EMA(close, period)，上下 = middle ± mult × ATR(atrPeriod)。 */
export function computeKeltner(
  bars: Candle[], period: number = 20, atrPeriod: number = 10, mult: number = 2,
): { upper: IndicatorPoint[]; middle: IndicatorPoint[]; lower: IndicatorPoint[] } {
  const mid = alignedEMA(bars.map((b) => b.close), period);
  const atr = alignedATRFromBars(bars, atrPeriod);
  const up = mid.map((m, i) => (Number.isFinite(m) && Number.isFinite(atr[i]) ? m + mult * atr[i] : NaN));
  const lo = mid.map((m, i) => (Number.isFinite(m) && Number.isFinite(atr[i]) ? m - mult * atr[i] : NaN));
  return {
    upper: pointsFromAligned(bars, up),
    middle: pointsFromAligned(bars, mid),
    lower: pointsFromAligned(bars, lo),
  };
}

/**
 * 拋物線 SAR（Wilder 經典演算法）。
 * 初始趨勢由第 2 根 close 相對第 1 根決定；輸出自 index 1 起（單根回空）。
 * 逐點 color：多方紅 / 空方綠（台灣配色）。
 */
export function computePSAR(bars: Candle[], step: number = 0.02, maxAf: number = 0.2): IndicatorPoint[] {
  const n = bars.length;
  const out: IndicatorPoint[] = [];
  if (n < 2 || step <= 0 || maxAf < step) return out;
  let up = bars[1].close >= bars[0].close;
  let sar = up ? bars[0].low : bars[0].high;
  let ep = up ? Math.max(bars[0].high, bars[1].high) : Math.min(bars[0].low, bars[1].low);
  let af = step;
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, bars[i - 1].low, i >= 2 ? bars[i - 2].low : bars[i - 1].low);
      if (bars[i].low < sar) {
        up = false; sar = ep; ep = bars[i].low; af = step;
      } else if (bars[i].high > ep) {
        ep = bars[i].high; af = Math.min(af + step, maxAf);
      }
    } else {
      sar = Math.max(sar, bars[i - 1].high, i >= 2 ? bars[i - 2].high : bars[i - 1].high);
      if (bars[i].high > sar) {
        up = true; sar = ep; ep = bars[i].high; af = step;
      } else if (bars[i].low < ep) {
        ep = bars[i].low; af = Math.min(af + step, maxAf);
      }
    }
    out.push({ time: bars[i].time, value: sar, color: up ? TREND_UP_COLOR : TREND_DOWN_COLOR });
  }
  return out;
}

/**
 * SuperTrend。
 * basic 上/下軌 = (H+L)/2 ± mult × ATR(period)（Wilder ATR，SMA 起種）。
 * final 軌道遞迴收斂；趨勢翻轉：多方時 close < 下軌 → 轉空；空方時 close > 上軌 → 轉多。
 * 初始趨勢：第一個可算點 close >= (H+L)/2 → 多，否則空。
 * 輸出單線：多方畫下軌（紅）、空方畫上軌（綠）。
 */
export function computeSuperTrend(bars: Candle[], period: number = 10, mult: number = 3): IndicatorPoint[] {
  const n = bars.length;
  const out: IndicatorPoint[] = [];
  if (period <= 0 || !Number.isInteger(period) || n < period) return out;
  const atr = alignedATRFromBars(bars, period);
  const start = period - 1;
  const hl2 = (i: number) => (bars[i].high + bars[i].low) / 2;
  let up = bars[start].close >= hl2(start);
  let fu = hl2(start) + mult * atr[start];
  let fl = hl2(start) - mult * atr[start];
  out.push({
    time: bars[start].time,
    value: up ? fl : fu,
    color: up ? TREND_UP_COLOR : TREND_DOWN_COLOR,
  });
  for (let i = start + 1; i < n; i++) {
    const bu = hl2(i) + mult * atr[i];
    const bl = hl2(i) - mult * atr[i];
    fu = (bu < fu || bars[i - 1].close > fu) ? bu : fu;
    fl = (bl > fl || bars[i - 1].close < fl) ? bl : fl;
    up = up ? bars[i].close >= fl : bars[i].close > fu;
    out.push({
      time: bars[i].time,
      value: up ? fl : fu,
      color: up ? TREND_UP_COLOR : TREND_DOWN_COLOR,
    });
  }
  return out;
}

/** 台北時區（UTC+8）曆日切 key（午夜對午夜）。一般曆日用途保留。 */
export function taipeiDayKey(unixSec: number): number {
  return Math.floor((unixSec + 8 * 3600) / 86400);
}

/**
 * TAIFEX「交易日」錨定 key（給 VWAP 用）：邊界改在台北 05:00，而非午夜。
 *
 * 動機：TAIFEX 夜盤 15:00 → 翌日 05:00 與其「日盤」同屬一個交易日。用午夜
 * 切（taipeiDayKey）會把連續的夜盤在 00:00 硬切成兩段、VWAP 於半夜重置——
 * 錯誤。改以 05:00 為邊界後：
 *   - 日盤 08:45–13:45 與其後夜盤 15:00–翌日 05:00 共用同一 key（連續累計）,
 *   - 夜盤跨過午夜（00:00）不會重置,
 *   - 新錨點落在 05:00 之後（下一個日盤開盤前的空窗），符合交易日語意。
 * 位移量 = +8h(tz) − 5h(session) = +3h。
 */
export function taifexTradingDayKey(unixSec: number): number {
  return Math.floor((unixSec + 3 * 3600) / 86400);
}

/**
 * VWAP（日內錨定版）：以 TAIFEX 交易日（台北 05:00 邊界）重置累計，使日盤 +
 * 其後夜盤（含跨午夜段）連續。舊版 computeVWAP 為全段累計，保留相容；
 * 圖表指標採本函式。
 */
export function computeVWAPDaily(bars: Candle[]): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let dayKey = Number.NaN;
  let cumPV = 0;
  let cumV = 0;
  for (const b of bars) {
    const key = taifexTradingDayKey(b.time);
    if (key !== dayKey) {
      dayKey = key;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    cumPV += tp * b.volume;
    cumV += b.volume;
    if (cumV > 0) out.push({ time: b.time, value: cumPV / cumV });
  }
  return out;
}

/** 價格包絡 Envelope：SMA(period) ± pct%。 */
export function computeEnvelope(bars: Candle[], period: number = 20, pct: number = 2.5): {
  upper: IndicatorPoint[]; middle: IndicatorPoint[]; lower: IndicatorPoint[];
} {
  const mid = alignedSMA(bars.map((b) => b.close), period);
  const up = mid.map((m) => (Number.isFinite(m) ? m * (1 + pct / 100) : NaN));
  const lo = mid.map((m) => (Number.isFinite(m) ? m * (1 - pct / 100) : NaN));
  return {
    upper: pointsFromAligned(bars, up),
    middle: pointsFromAligned(bars, mid),
    lower: pointsFromAligned(bars, lo),
  };
}

/* ── 副圖 pane 指標 ────────────────────────────────────────────── */

/**
 * MACD：DIF = EMA(fast) − EMA(slow)；DEA = EMA(DIF, signal)；OSC 柱 = DIF − DEA。
 * EMA 皆為 SMA 起種（與 computeEMA 同一約定）；DEA 對 DIF 的前緣 NaN 自動跳過。
 */
export function computeMACD(
  bars: Candle[], fast: number = 12, slow: number = 26, signal: number = 9,
): { dif: IndicatorPoint[]; dea: IndicatorPoint[]; hist: IndicatorPoint[] } {
  const closes = bars.map((b) => b.close);
  const emaF = alignedEMA(closes, fast);
  const emaS = alignedEMA(closes, slow);
  const dif = emaF.map((f, i) => (Number.isFinite(f) && Number.isFinite(emaS[i]) ? f - emaS[i] : NaN));
  const dea = alignedEMA(dif, signal);
  const hist = dif.map((d, i) => (Number.isFinite(d) && Number.isFinite(dea[i]) ? d - dea[i] : NaN));
  const colors = hist.map((h) => (Number.isFinite(h) ? (h >= 0 ? HIST_UP_COLOR : HIST_DOWN_COLOR) : undefined));
  return {
    dif: pointsFromAligned(bars, dif),
    dea: pointsFromAligned(bars, dea),
    hist: pointsFromAligned(bars, hist, colors),
  };
}

/**
 * KD 隨機指標（台股慣例的慢速 KD）：
 * RSV = (C − LLV) / (HHV − LLV) × 100（HHV=LLV 時取 50）；
 * K = (前K × (kSmooth−1) + RSV) / kSmooth（K 初始 50）；
 * D = (前D × (dSmooth−1) + K) / dSmooth（D 初始 50）。
 * kSmooth=dSmooth=3 即常見「K=2/3前K+1/3RSV」。
 */
export function computeKD(
  bars: Candle[], period: number = 9, kSmooth: number = 3, dSmooth: number = 3,
): { k: IndicatorPoint[]; d: IndicatorPoint[] } {
  const kOut: IndicatorPoint[] = [];
  const dOut: IndicatorPoint[] = [];
  if (period <= 0 || kSmooth <= 0 || dSmooth <= 0 || !Number.isInteger(period) || bars.length < period) {
    return { k: kOut, d: dOut };
  }
  let k = 50;
  let d = 50;
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].high > hh) hh = bars[j].high;
      if (bars[j].low < ll) ll = bars[j].low;
    }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
    k = (k * (kSmooth - 1) + rsv) / kSmooth;
    d = (d * (dSmooth - 1) + k) / dSmooth;
    kOut.push({ time: bars[i].time, value: k });
    dOut.push({ time: bars[i].time, value: d });
  }
  return { k: kOut, d: dOut };
}

/** ATR 點列（Wilder，SMA 起種）。 */
export function computeATR(bars: Candle[], period: number = 14): IndicatorPoint[] {
  return pointsFromAligned(bars, alignedATRFromBars(bars, period));
}

/** CCI 順勢指標：(TP − SMA(TP)) / (0.015 × 平均絕對偏差)。偏差 0 → 0。 */
export function computeCCI(bars: Candle[], period: number = 20): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (period <= 0 || !Number.isInteger(period) || bars.length < period) return out;
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tp[j];
    const mean = sum / period;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - mean);
    const md = dev / period;
    out.push({ time: bars[i].time, value: md === 0 ? 0 : (tp[i] - mean) / (0.015 * md) });
  }
  return out;
}

/** OBV 能量潮：自 0 起算；收漲 +vol、收跌 −vol、平盤不動。 */
export function computeOBV(bars: Candle[]): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let obv = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      if (bars[i].close > bars[i - 1].close) obv += bars[i].volume;
      else if (bars[i].close < bars[i - 1].close) obv -= bars[i].volume;
    }
    out.push({ time: bars[i].time, value: obv });
  }
  return out;
}

/** 威廉指標 %R：(HHV − C) / (HHV − LLV) × −100，範圍 [−100, 0]。HHV=LLV → −50。 */
export function computeWilliamsR(bars: Candle[], period: number = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (period <= 0 || !Number.isInteger(period) || bars.length < period) return out;
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].high > hh) hh = bars[j].high;
      if (bars[j].low < ll) ll = bars[j].low;
    }
    out.push({
      time: bars[i].time,
      value: hh === ll ? -50 : ((hh - bars[i].close) / (hh - ll)) * -100,
    });
  }
  return out;
}

/**
 * MFI 資金流量指標：TP 上升的 TP×V 記正流、下降記負流、持平不計；
 * MFI = 100 − 100/(1 + 正流/負流)。負流 0 → 100；正流 0 → 0；皆 0 → 50。
 */
export function computeMFI(bars: Candle[], period: number = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (period <= 0 || !Number.isInteger(period) || bars.length <= period) return out;
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  for (let i = period; i < bars.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = tp[j] * bars[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    let mfi: number;
    if (pos === 0 && neg === 0) mfi = 50;
    else if (neg === 0) mfi = 100;
    else if (pos === 0) mfi = 0;
    else mfi = 100 - 100 / (1 + pos / neg);
    out.push({ time: bars[i].time, value: mfi });
  }
  return out;
}

/** 動量 ROC：(C / C[n 根前] − 1) × 100。 */
export function computeROC(bars: Candle[], period: number = 12): IndicatorPoint[] {
  return pointsFromAligned(bars, alignedROC(bars.map((b) => b.close), period));
}

/**
 * DMI / ADX（Wilder）：
 * +DM/−DM 取方向移動較大者；Wilder 累計平滑（首值 = 前 period 根和）；
 * ±DI = 100 × 平滑DM / 平滑TR；DX = 100 × |+DI − −DI| / (+DI + −DI)；
 * ADX = DX 的 Wilder 平均（首值 = 前 adxPeriod 根 DX 簡單平均）。
 * ±DI 自 index = period 起輸出；ADX 自 index = period + adxPeriod − 1 起。
 */
export function computeDMI(bars: Candle[], period: number = 14, adxPeriod: number = 14): {
  plusDI: IndicatorPoint[]; minusDI: IndicatorPoint[]; adx: IndicatorPoint[];
} {
  const plusDI: IndicatorPoint[] = [];
  const minusDI: IndicatorPoint[] = [];
  const adx: IndicatorPoint[] = [];
  const n = bars.length;
  if (period <= 0 || adxPeriod <= 0 || !Number.isInteger(period) || !Number.isInteger(adxPeriod) || n <= period) {
    return { plusDI, minusDI, adx };
  }
  const pdm = new Array<number>(n).fill(0);
  const mdm = new Array<number>(n).fill(0);
  const tr = alignedTR(bars);
  for (let i = 1; i < n; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    pdm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    mdm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  // Wilder 累計平滑（sum 版）：首值 = Σ(1..period)，之後 s = s − s/period + x
  let sTR = 0;
  let sPDM = 0;
  let sMDM = 0;
  for (let i = 1; i <= period; i++) {
    sTR += tr[i];
    sPDM += pdm[i];
    sMDM += mdm[i];
  }
  let dxRun = 0;
  let dxCount = 0;
  let adxVal = NaN;
  for (let i = period; i < n; i++) {
    if (i > period) {
      sTR = sTR - sTR / period + tr[i];
      sPDM = sPDM - sPDM / period + pdm[i];
      sMDM = sMDM - sMDM / period + mdm[i];
    }
    const pdi = sTR === 0 ? 0 : (100 * sPDM) / sTR;
    const mdi = sTR === 0 ? 0 : (100 * sMDM) / sTR;
    plusDI.push({ time: bars[i].time, value: pdi });
    minusDI.push({ time: bars[i].time, value: mdi });
    const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    if (!Number.isFinite(adxVal)) {
      dxRun += dx;
      dxCount++;
      if (dxCount === adxPeriod) adxVal = dxRun / adxPeriod;
    } else {
      adxVal = (adxVal * (adxPeriod - 1) + dx) / adxPeriod;
    }
    if (Number.isFinite(adxVal)) adx.push({ time: bars[i].time, value: adxVal });
  }
  return { plusDI, minusDI, adx };
}

/** 成交量（紅漲綠跌逐根上色）+ 量均線 SMA(maPeriod)。 */
export function computeVolumeMA(bars: Candle[], maPeriod: number = 5): {
  volume: IndicatorPoint[]; volMA: IndicatorPoint[];
} {
  const volume = bars.map((b) => ({
    time: b.time,
    value: b.volume,
    color: b.close >= b.open ? VOL_UP_COLOR : VOL_DOWN_COLOR,
  }));
  const volMA = pointsFromAligned(bars, alignedSMA(bars.map((b) => b.volume), maPeriod));
  return { volume, volMA };
}
