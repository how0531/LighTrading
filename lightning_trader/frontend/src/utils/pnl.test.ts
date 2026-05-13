/**
 * computeLocalPnL 純函式測試（vitest）
 *
 * 對應 Sprint 0 S0-1 的前端即時損益計算邏輯。
 * 與後端 pnl_broadcaster.py 的 _compute_pnl_payload 是雙保險（後端有 pytest，
 * 前端也獨立計算以省 1 個 round-trip），所以兩邊邏輯都要測。
 */
import { describe, it, expect } from 'vitest';
import { computeLocalPnL } from './pnl';

describe('computeLocalPnL', () => {
  it('returns zero when no positions', () => {
    const r = computeLocalPnL([], 17000, 'TXFR1');
    expect(r.positions).toEqual([]);
    expect(r.totalPnl).toBe(0);
  });

  it('returns zero when price is non-positive', () => {
    const r = computeLocalPnL(
      [{ symbol: 'TXFR1', qty: 1, direction: 'Buy', price: 17000, pnl: 0 }],
      0, 'TXFR1',
    );
    expect(r.totalPnl).toBe(0);
  });

  it('TXFR1 long 1 lot +50pt = +10000', () => {
    const r = computeLocalPnL(
      [{ symbol: 'TXFR1', qty: 1, direction: 'Buy', price: 17000, pnl: 0 }],
      17050, 'TXFR1',
    );
    expect(r.totalPnl).toBe(10000);
    expect(r.positions[0].realtimePnl).toBe(10000);
    expect(r.positions[0].pnlPerUnit).toBe(50);
  });

  it('TXFR1 short 2 lots tick down 25pt = +10000', () => {
    const r = computeLocalPnL(
      [{ symbol: 'TXFR1', qty: 2, direction: 'Sell', price: 17000, pnl: 0 }],
      16975, 'TXFR1',
    );
    expect(r.totalPnl).toBe(10000);
  });

  it('non-target symbol falls back to broker pnl', () => {
    const r = computeLocalPnL(
      [{ symbol: 'MXFR1', qty: 1, direction: 'Buy', price: 17000, pnl: 1234 }],
      17050, 'TXFR1',  // target ≠ position symbol
    );
    expect(r.totalPnl).toBe(1234);
    expect(r.positions[0].pnlPerUnit).toBe(0);
  });

  it('matches by digit-code (e.g. "2330" matches "TSE2330")', () => {
    const r = computeLocalPnL(
      [{ symbol: 'TSE2330', qty: 1, direction: 'Buy', price: 600, pnl: 0 }],
      610, '2330',
    );
    // 股票乘數預設 1000：(610-600) * 1 * 1000 = 10000
    expect(r.totalPnl).toBe(10000);
  });

  it('aggregates multi-position correctly', () => {
    const r = computeLocalPnL(
      [
        { symbol: 'TXFR1', qty: 1, direction: 'Buy', price: 17000, pnl: 0 },
        { symbol: 'MXFR1', qty: 2, direction: 'Sell', price: 17000, pnl: 500 },
      ],
      17050, 'TXFR1',
    );
    // TXFR1 +10000；MXFR1 非 target → broker pnl 500
    expect(r.totalPnl).toBe(10500);
  });
});
