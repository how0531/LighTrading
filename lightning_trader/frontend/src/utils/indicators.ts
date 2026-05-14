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
