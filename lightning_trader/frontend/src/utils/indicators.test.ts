import { describe, it, expect } from 'vitest';
import { computeSMA, computeVWAP } from './indicators';

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
