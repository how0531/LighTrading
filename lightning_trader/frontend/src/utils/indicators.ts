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
