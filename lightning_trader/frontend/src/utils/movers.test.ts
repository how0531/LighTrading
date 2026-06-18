/**
 * movers 純函式測試（vitest）— Sprint 36
 */
import { describe, it, expect } from 'vitest';
import { rankMovers, computeBreadth } from './movers';

const SAMPLE = [
  { symbol: 'AAA', price: 110, reference: 100 }, // +10%
  { symbol: 'BBB', price: 95, reference: 100 },  // -5%
  { symbol: 'CCC', price: 103, reference: 100 }, // +3%
  { symbol: 'DDD', price: 100, reference: 100 }, // 0%
  { symbol: 'EEE', price: 0, reference: 100 },   // 無有效報價
  { symbol: 'FFF', price: 80, reference: 100 },  // -20%
];

describe('rankMovers', () => {
  it('漲幅榜由大到小', () => {
    const g = rankMovers(SAMPLE, 'gainers', 3);
    expect(g.map((r) => r.symbol)).toEqual(['AAA', 'CCC', 'DDD']);
    expect(g[0].pct).toBeCloseTo(10);
  });

  it('跌幅榜最跌的在最前', () => {
    const l = rankMovers(SAMPLE, 'losers', 3);
    expect(l.map((r) => r.symbol)).toEqual(['FFF', 'BBB', 'DDD']);
    expect(l[0].pct).toBeCloseTo(-20);
  });

  it('濾掉無有效報價的列（不佔名額）', () => {
    const all = rankMovers(SAMPLE, 'gainers', 0);
    expect(all.map((r) => r.symbol)).not.toContain('EEE');
    expect(all.length).toBe(5);
  });

  it('limit 限制回傳筆數', () => {
    expect(rankMovers(SAMPLE, 'gainers', 2).length).toBe(2);
  });

  it('limit <= 0 不限制', () => {
    expect(rankMovers(SAMPLE, 'gainers', -1).length).toBe(5);
  });

  it('空陣列 → 空榜', () => {
    expect(rankMovers([], 'gainers', 5)).toEqual([]);
  });

  it('MoverRow 帶 change / pct / price', () => {
    const [top] = rankMovers(SAMPLE, 'gainers', 1);
    expect(top).toEqual({ symbol: 'AAA', price: 110, change: 10, pct: 10 });
  });
});

describe('computeBreadth', () => {
  it('正確統計漲跌平與無資料家數', () => {
    const b = computeBreadth(SAMPLE);
    expect(b.up).toBe(2);    // AAA, CCC
    expect(b.down).toBe(2);  // BBB, FFF
    expect(b.flat).toBe(1);  // DDD
    expect(b.noData).toBe(1); // EEE
    expect(b.total).toBe(6);
    expect(b.upPct).toBeCloseTo(50);
  });

  it('全漲 → upPct 100', () => {
    const b = computeBreadth([
      { symbol: 'A', price: 110, reference: 100 },
      { symbol: 'B', price: 120, reference: 100 },
    ]);
    expect(b.up).toBe(2);
    expect(b.down).toBe(0);
    expect(b.upPct).toBe(100);
  });

  it('無漲跌家數 → upPct 退回 50', () => {
    const b = computeBreadth([
      { symbol: 'A', price: 100, reference: 100 }, // flat
      { symbol: 'B', price: 0, reference: 100 },   // noData
    ]);
    expect(b.up).toBe(0);
    expect(b.down).toBe(0);
    expect(b.flat).toBe(1);
    expect(b.noData).toBe(1);
    expect(b.upPct).toBe(50);
  });

  it('空陣列 → 全 0、upPct 50', () => {
    expect(computeBreadth([])).toEqual({ up: 0, down: 0, flat: 0, noData: 0, total: 0, upPct: 50 });
  });
});
