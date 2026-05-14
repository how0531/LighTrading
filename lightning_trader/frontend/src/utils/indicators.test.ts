import { describe, it, expect } from 'vitest';
import { computeSMA, computeVWAP, computeRSI } from './indicators';

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
