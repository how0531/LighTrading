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
