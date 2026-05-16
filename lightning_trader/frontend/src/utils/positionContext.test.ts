import { describe, it, expect } from 'vitest';
import {
  firstEntryTs,
  entryFillCount,
  formatHolding,
  nearestStopTrigger,
  distanceToStop,
  type FillLite,
  type SmartOrderLite,
} from './positionContext';

const F = (ts: number, action: 'Buy' | 'Sell', price = 100, qty = 1): FillLite => ({
  ts, action, price, qty, symbol: 'TXFR1',
});

describe('firstEntryTs', () => {
  it('多單取最早 Buy', () => {
    expect(firstEntryTs([F(3000, 'Buy'), F(1000, 'Buy'), F(2000, 'Sell')], 'Buy')).toBe(1000);
  });
  it('空單取最早 Sell', () => {
    expect(firstEntryTs([F(5000, 'Sell'), F(2000, 'Sell')], 'Sell')).toBe(2000);
  });
  it('無同向 fill → 0', () => {
    expect(firstEntryTs([F(1000, 'Sell')], 'Buy')).toBe(0);
  });
  it('ts<=0 被忽略', () => {
    expect(firstEntryTs([F(0, 'Buy'), F(4000, 'Buy')], 'Buy')).toBe(4000);
  });
});

describe('entryFillCount', () => {
  it('數同向分批次數', () => {
    expect(entryFillCount([F(1, 'Buy'), F(2, 'Buy'), F(3, 'Sell')], 'Buy')).toBe(2);
  });
  it('無 → 0', () => {
    expect(entryFillCount([F(1, 'Sell')], 'Buy')).toBe(0);
  });
});

describe('formatHolding', () => {
  it('0 / 負 → —', () => {
    expect(formatHolding(0)).toBe('—');
    expect(formatHolding(-5)).toBe('—');
  });
  it('秒', () => expect(formatHolding(45_000)).toBe('45秒'));
  it('分', () => expect(formatHolding(5 * 60_000)).toBe('5分'));
  it('時 (整時不顯示分)', () => expect(formatHolding(3 * 3_600_000)).toBe('3時'));
  it('時+分', () => expect(formatHolding(3 * 3_600_000 + 12 * 60_000)).toBe('3時12分'));
  it('天 (整天不顯示時)', () => expect(formatHolding(2 * 86_400_000)).toBe('2天'));
  it('天+時', () => expect(formatHolding(2 * 86_400_000 + 5 * 3_600_000)).toBe('2天5時'));
});

describe('nearestStopTrigger', () => {
  const SO = (action: string, trigger: number, extra: Partial<SmartOrderLite> = {}): SmartOrderLite => ({
    symbol: 'TXFR1', order_type: 'STOP', action, trigger_price: trigger,
    is_active: true, is_triggered: false, ...extra,
  });
  it('多單停損取最高 Sell STOP', () => {
    expect(nearestStopTrigger([SO('Sell', 16900), SO('Sell', 16950)], 'TXFR1', 'Buy')).toBe(16950);
  });
  it('空單停損取最低 Buy STOP', () => {
    expect(nearestStopTrigger([SO('Buy', 17100), SO('Buy', 17050)], 'TXFR1', 'Sell')).toBe(17050);
  });
  it('忽略已觸發 / 非 active / 非 STOP / 別的 symbol', () => {
    const list = [
      SO('Sell', 16800, { is_triggered: true }),
      SO('Sell', 16850, { is_active: false }),
      SO('Sell', 16900, { order_type: 'LIMIT' }),
      SO('Sell', 16950, { symbol: 'MXFR1' }),
      SO('Sell', 16700),
    ];
    expect(nearestStopTrigger(list, 'TXFR1', 'Buy')).toBe(16700);
  });
  it('無對應 → 0', () => {
    expect(nearestStopTrigger([SO('Buy', 17000)], 'TXFR1', 'Buy')).toBe(0);
  });
});

describe('distanceToStop', () => {
  it('多單：現價在停損上方為正', () => {
    const r = distanceToStop(17000, 'Buy', 16830);
    expect(r).toEqual({ points: 170, pct: 1, trigger: 16830 });
  });
  it('多單：穿價為負', () => {
    const r = distanceToStop(16800, 'Buy', 16830);
    expect(r!.points).toBe(-30);
    expect(r!.pct).toBeCloseTo(-0.18, 2);
  });
  it('空單：現價在停損下方為正', () => {
    const r = distanceToStop(17000, 'Sell', 17170);
    expect(r).toEqual({ points: 170, pct: 1, trigger: 17170 });
  });
  it('trigger<=0 → null', () => {
    expect(distanceToStop(17000, 'Buy', 0)).toBeNull();
  });
  it('price<=0 → null', () => {
    expect(distanceToStop(0, 'Buy', 16830)).toBeNull();
  });
});
