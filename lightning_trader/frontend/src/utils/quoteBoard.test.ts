/**
 * quoteBoard 純函式測試（vitest）— Sprint 34
 */
import { describe, it, expect } from 'vitest';
import { computeChange, isStaleQuote, sortQuotes } from './quoteBoard';

describe('computeChange', () => {
  it('參考價為 0 時回 null', () => {
    expect(computeChange(100, 0)).toBeNull();
  });

  it('成交價為 0 時回 null', () => {
    expect(computeChange(0, 100)).toBeNull();
  });

  it('上漲:漲跌與漲跌幅正確', () => {
    const r = computeChange(105, 100);
    expect(r).not.toBeNull();
    expect(r!.change).toBeCloseTo(5);
    expect(r!.pct).toBeCloseTo(5);
  });

  it('下跌:回傳負值', () => {
    const r = computeChange(95, 100);
    expect(r!.change).toBeCloseTo(-5);
    expect(r!.pct).toBeCloseTo(-5);
  });
});

describe('isStaleQuote', () => {
  const now = 1_000_000;

  it('沒有 updatedAt 視為 stale', () => {
    expect(isStaleQuote(undefined, now)).toBe(true);
  });

  it('剛更新不算 stale', () => {
    expect(isStaleQuote(now - 1000, now)).toBe(false);
  });

  it('超過門檻算 stale', () => {
    expect(isStaleQuote(now - 11_000, now)).toBe(true);
  });

  it('可自訂門檻', () => {
    expect(isStaleQuote(now - 3000, now, 2000)).toBe(true);
    expect(isStaleQuote(now - 1000, now, 2000)).toBe(false);
  });
});

describe('sortQuotes', () => {
  const rows = [
    { symbol: '2330', price: 600, reference: 590, volume: 100 },
    { symbol: 'TXFR1', price: 18000, reference: 18200, volume: 50 },
    { symbol: '2317', price: 100, reference: 100, volume: 300 },
  ];

  it('依代號升冪', () => {
    const out = sortQuotes(rows, 'symbol', 'asc');
    expect(out.map((r) => r.symbol)).toEqual(['2317', '2330', 'TXFR1']);
  });

  it('依代號降冪', () => {
    const out = sortQuotes(rows, 'symbol', 'desc');
    expect(out.map((r) => r.symbol)).toEqual(['TXFR1', '2330', '2317']);
  });

  it('依成交價降冪', () => {
    const out = sortQuotes(rows, 'price', 'desc');
    expect(out.map((r) => r.symbol)).toEqual(['TXFR1', '2330', '2317']);
  });

  it('依總量升冪', () => {
    const out = sortQuotes(rows, 'volume', 'asc');
    expect(out.map((r) => r.volume)).toEqual([50, 100, 300]);
  });

  it('依漲跌幅降冪:上漲在前、下跌在後', () => {
    const out = sortQuotes(rows, 'changePct', 'desc');
    // 2330 +1.69%, 2317 0%, TXFR1 -1.1%
    expect(out.map((r) => r.symbol)).toEqual(['2330', '2317', 'TXFR1']);
  });

  it('缺漲跌資料的列在 changePct 降冪時墊底', () => {
    const withMissing = [
      { symbol: 'A', price: 10, reference: 9 },     // +11%
      { symbol: 'B', price: 0, reference: 0 },       // 無資料 → -Infinity
    ];
    const out = sortQuotes(withMissing, 'changePct', 'desc');
    expect(out.map((r) => r.symbol)).toEqual(['A', 'B']);
  });

  it('不就地修改輸入陣列', () => {
    const original = [...rows];
    sortQuotes(rows, 'price', 'asc');
    expect(rows).toEqual(original);
  });
});
