import { describe, it, expect } from 'vitest';
import { computeSMA, computeVWAP, computeRSI, computeEMA, computeBollinger } from './indicators';

const B = (t: number, c: number, v: number = 0) => ({
  time: t, open: c, high: c, low: c, close: c, volume: v,
});

describe('computeSMA', () => {
  it('returns empty when bars < period', () => {
    expect(computeSMA([B(1, 10), B(2, 11)], 3)).toEqual([]);
  });

  it('returns empty for period <= 0', () => {
    expect(computeSMA([B(1, 10)], 0)).toEqual([]);
    expect(computeSMA([B(1, 10)], -1)).toEqual([]);
  });

  it('computes rolling average with right length', () => {
    const bars = [B(1, 10), B(2, 20), B(3, 30), B(4, 40), B(5, 50)];
    const sma = computeSMA(bars, 3);
    expect(sma).toEqual([
      { time: 3, value: 20 },  // (10+20+30)/3
      { time: 4, value: 30 },  // (20+30+40)/3
      { time: 5, value: 40 },  // (30+40+50)/3
    ]);
  });

  it('period equal to length emits exactly one point', () => {
    const bars = [B(1, 10), B(2, 20), B(3, 30)];
    const sma = computeSMA(bars, 3);
    expect(sma).toEqual([{ time: 3, value: 20 }]);
  });
});

describe('computeVWAP', () => {
  it('returns empty for empty bars', () => {
    expect(computeVWAP([])).toEqual([]);
  });

  it('skips bars with zero cumulative volume', () => {
    // first bar volume=0 → cumV still 0 → no point
    const out = computeVWAP([B(1, 100, 0)]);
    expect(out).toEqual([]);
  });

  it('accumulates typical price × volume correctly', () => {
    // bar 1: high=low=close=100, vol=1 → tp=100, cumPV=100, cumV=1, vwap=100
    // bar 2: high=low=close=200, vol=1 → tp=200, cumPV=300, cumV=2, vwap=150
    // bar 3: high=low=close=300, vol=1 → tp=300, cumPV=600, cumV=3, vwap=200
    const bars = [B(1, 100, 1), B(2, 200, 1), B(3, 300, 1)];
    expect(computeVWAP(bars)).toEqual([
      { time: 1, value: 100 },
      { time: 2, value: 150 },
      { time: 3, value: 200 },
    ]);
  });

  it('weights by volume correctly', () => {
    // bar 1: close=100, vol=1 → vwap=100
    // bar 2: close=200, vol=4 → cumPV=100+800=900, cumV=5 → vwap=180
    const bars = [B(1, 100, 1), B(2, 200, 4)];
    expect(computeVWAP(bars)).toEqual([
      { time: 1, value: 100 },
      { time: 2, value: 180 },
    ]);
  });
});

describe('computeEMA', () => {
  it('returns empty when bars < period', () => {
    expect(computeEMA([B(1, 10), B(2, 11)], 3)).toEqual([]);
  });

  it('returns empty for period <= 0', () => {
    expect(computeEMA([B(1, 10)], 0)).toEqual([]);
    expect(computeEMA([B(1, 10)], -1)).toEqual([]);
  });

  it('computes EMA by hand (period=3, k=0.5)', () => {
    // SMA 初始 = (10+20+30)/3 = 20（time=3）
    // k = 2/(3+1) = 0.5
    // time=4: 40*0.5 + 20*0.5 = 30
    // time=5: 50*0.5 + 30*0.5 = 40
    const bars = [B(1, 10), B(2, 20), B(3, 30), B(4, 40), B(5, 50)];
    expect(computeEMA(bars, 3)).toEqual([
      { time: 3, value: 20 },
      { time: 4, value: 30 },
      { time: 5, value: 40 },
    ]);
  });

  it('computes EMA by hand on non-trivial decimals', () => {
    // closes = [10, 11, 13, 14, 12], period=3, k=0.5
    // 初始 SMA = 34/3 ≈ 11.3333（time=3）
    // time=4: 14*0.5 + 11.3333*0.5 = 12.6667
    // time=5: 12*0.5 + 12.6667*0.5 = 12.3333
    const bars = [10, 11, 13, 14, 12].map((c, i) => B(i + 1, c));
    const ema = computeEMA(bars, 3);
    expect(ema.length).toBe(3);
    expect(ema[0].value).toBeCloseTo(34 / 3, 10);
    expect(ema[1].value).toBeCloseTo((14 + 34 / 3) / 2, 10);
    expect(ema[2].value).toBeCloseTo((12 + (14 + 34 / 3) / 2) / 2, 10);
  });

  it('first point aligns with SMA start (same time, same value)', () => {
    const bars = Array.from({ length: 10 }, (_, i) => B(i + 1, 100 + i * 2));
    const ema = computeEMA(bars, 5);
    const sma = computeSMA(bars, 5);
    // 起點 index = period - 1，與 SMA 對齊；第一個值即 SMA 初始化
    expect(ema.length).toBe(sma.length);
    expect(ema[0].time).toBe(sma[0].time);
    expect(ema[0].value).toBeCloseTo(sma[0].value, 10);
  });

  it('period equal to length emits exactly one point (= SMA)', () => {
    const bars = [B(1, 10), B(2, 20), B(3, 30)];
    expect(computeEMA(bars, 3)).toEqual([{ time: 3, value: 20 }]);
  });
});

describe('computeBollinger', () => {
  it('returns three empty arrays when bars < period', () => {
    const r = computeBollinger([B(1, 10), B(2, 11)], 3);
    expect(r).toEqual({ upper: [], middle: [], lower: [] });
  });

  it('returns three empty arrays for period <= 0', () => {
    expect(computeBollinger([B(1, 10)], 0)).toEqual({ upper: [], middle: [], lower: [] });
    expect(computeBollinger([B(1, 10)], -1)).toEqual({ upper: [], middle: [], lower: [] });
  });

  it('constant prices → sigma=0 → three bands coincide', () => {
    const bars = Array.from({ length: 6 }, (_, i) => B(i + 1, 100));
    const { upper, middle, lower } = computeBollinger(bars, 3, 2);
    expect(middle.length).toBe(4);
    expect(upper).toEqual(middle);
    expect(lower).toEqual(middle);
    middle.forEach((p) => expect(p.value).toBe(100));
  });

  it('computes bands by hand (period=2, mult=2)', () => {
    // 視窗 [10,20]: mean=15, 母體 σ = 5 → upper=25, lower=5（time=2）
    // 視窗 [20,30]: mean=25, σ = 5 → upper=35, lower=15（time=3）
    const bars = [B(1, 10), B(2, 20), B(3, 30)];
    const { upper, middle, lower } = computeBollinger(bars, 2, 2);
    expect(middle).toEqual([
      { time: 2, value: 15 },
      { time: 3, value: 25 },
    ]);
    expect(upper).toEqual([
      { time: 2, value: 25 },
      { time: 3, value: 35 },
    ]);
    expect(lower).toEqual([
      { time: 2, value: 5 },
      { time: 3, value: 15 },
    ]);
  });

  it('uses population std dev (divide by N), hand-checked decimals', () => {
    // closes = [10, 12, 14, 16], period=3, mult=1
    // 視窗1 [10,12,14]: mean=12, σ = sqrt((4+0+4)/3) = sqrt(8/3)
    // 視窗2 [12,14,16]: mean=14, σ = sqrt(8/3)
    const bars = [10, 12, 14, 16].map((c, i) => B(i + 1, c));
    const sigma = Math.sqrt(8 / 3);
    const { upper, middle, lower } = computeBollinger(bars, 3, 1);
    expect(middle.map((p) => p.value)).toEqual([12, 14]);
    expect(upper[0].value).toBeCloseTo(12 + sigma, 10);
    expect(upper[1].value).toBeCloseTo(14 + sigma, 10);
    expect(lower[0].value).toBeCloseTo(12 - sigma, 10);
    expect(lower[1].value).toBeCloseTo(14 - sigma, 10);
  });

  it('three arrays have equal length and aligned times', () => {
    const bars = Array.from({ length: 30 }, (_, i) => B(i + 1, 100 + Math.sin(i) * 5));
    const { upper, middle, lower } = computeBollinger(bars, 5, 2);
    expect(upper.length).toBe(middle.length);
    expect(lower.length).toBe(middle.length);
    middle.forEach((p, i) => {
      expect(upper[i].time).toBe(p.time);
      expect(lower[i].time).toBe(p.time);
      expect(upper[i].value).toBeGreaterThanOrEqual(p.value);
      expect(lower[i].value).toBeLessThanOrEqual(p.value);
    });
  });

  it('defaults to period=20, mult=2', () => {
    // 21 根遞增 → period=20 時應有 2 點；middle 與 SMA(20) 一致
    const bars = Array.from({ length: 21 }, (_, i) => B(i + 1, 100 + i));
    const { upper, middle, lower } = computeBollinger(bars);
    expect(middle.length).toBe(2);
    expect(middle[0].time).toBe(20);
    expect(middle).toEqual(computeSMA(bars, 20));
    // 等差數列 0..19，母體 σ = sqrt(Σ(i-9.5)²/20) = sqrt(33.25)
    const sigma = Math.sqrt(33.25);
    expect(upper[0].value).toBeCloseTo(middle[0].value + 2 * sigma, 10);
    expect(lower[0].value).toBeCloseTo(middle[0].value - 2 * sigma, 10);
  });
});

describe('computeRSI', () => {
  it('returns empty when bars <= period', () => {
    expect(computeRSI([B(1, 10), B(2, 11)], 5)).toEqual([]);
    // 等於 period 也回空（至少要 period+1 根才有第一根 diff）
    expect(computeRSI([B(1, 10), B(2, 11), B(3, 12)], 3)).toEqual([]);
  });

  it('returns empty for non-positive period', () => {
    expect(computeRSI([B(1, 10)], 0)).toEqual([]);
    expect(computeRSI([B(1, 10)], -1)).toEqual([]);
  });

  it('all rising bars → RSI 100 (no losses)', () => {
    const bars = [B(1, 10), B(2, 11), B(3, 12), B(4, 13), B(5, 14)];
    const r = computeRSI(bars, 3);
    expect(r.length).toBeGreaterThan(0);
    // 全 gain → avgLoss=0 → 100
    r.forEach((p) => expect(p.value).toBe(100));
  });

  it('all falling bars → RSI 0', () => {
    const bars = [B(1, 14), B(2, 13), B(3, 12), B(4, 11), B(5, 10)];
    const r = computeRSI(bars, 3);
    expect(r.length).toBeGreaterThan(0);
    r.forEach((p) => expect(p.value).toBe(0));
  });

  it('alternating up/down with even period → RSI = 50', () => {
    // period=4，前 4 個 diff 嚴格交替 +1,-1,+1,-1 → gain=2/4, loss=2/4 → RSI=50
    const bars = [10, 11, 10, 11, 10].map((c, i) => B(i + 1, c));
    const r = computeRSI(bars, 4);
    expect(r.length).toBe(1);
    expect(r[0].value).toBe(50);
  });

  it('2:1 gain-loss ratio → RSI ≈ 66.67', () => {
    // period=3，前 3 diff +1,-1,+1 → gain=2/3, loss=1/3 → RS=2 → RSI=66.67
    const bars = [10, 11, 10, 11].map((c, i) => B(i + 1, c));
    const r = computeRSI(bars, 3);
    expect(r[0].value).toBeCloseTo(100 * 2 / 3, 1);
  });

  it('emits one point per bar after warmup', () => {
    const bars = Array.from({ length: 20 }, (_, i) => B(i + 1, 100 + i));
    const r = computeRSI(bars, 5);
    // bars.length=20, period=5 → 第一根 RSI at bar index=5（time=6），共 20-5=15 點
    expect(r.length).toBe(15);
    expect(r[0].time).toBe(6);
  });
});
