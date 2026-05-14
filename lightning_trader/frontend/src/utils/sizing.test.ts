import { describe, it, expect } from 'vitest';
import { amountToLots, equityPctToLots, lotsToAmount, resolveLots } from './sizing';

describe('amountToLots', () => {
  it('台股 100,000 @ 23 → 4 張 (multiplier=1000)', () => {
    expect(amountToLots(100_000, { price: 23, multiplier: 1000, equity: 0 })).toBe(4);
  });
  it('TXF 100,000 @ 17000 → 0 口（一口要 3.4M）', () => {
    expect(amountToLots(100_000, { price: 17000, multiplier: 200, equity: 0 })).toBe(0);
  });
  it('MXF 800,000 @ 17000 → 0（不足一口）', () => {
    expect(amountToLots(800_000, { price: 17000, multiplier: 50, equity: 0 })).toBe(0);
  });
  it('MXF 900,000 @ 17000 → 1 口', () => {
    expect(amountToLots(900_000, { price: 17000, multiplier: 50, equity: 0 })).toBe(1);
  });
  it('amount=0 → 0', () => {
    expect(amountToLots(0, { price: 23, multiplier: 1000, equity: 0 })).toBe(0);
  });
  it('price=0 不會除以零', () => {
    expect(amountToLots(100_000, { price: 0, multiplier: 1000, equity: 0 })).toBe(0);
  });
  it('floor 而非 round（99,999 @ 23 → 4 而非 5）', () => {
    expect(amountToLots(99_999, { price: 23, multiplier: 1000, equity: 0 })).toBe(4);
  });
});

describe('equityPctToLots', () => {
  it('5% of 1M @ 台股 23 → 50000/23000 = 2 張', () => {
    expect(equityPctToLots(5, { price: 23, multiplier: 1000, equity: 1_000_000 })).toBe(2);
  });
  it('10% of 1M @ 台股 23 → 4 張', () => {
    expect(equityPctToLots(10, { price: 23, multiplier: 1000, equity: 1_000_000 })).toBe(4);
  });
  it('pct > 100 → 0', () => {
    expect(equityPctToLots(150, { price: 23, multiplier: 1000, equity: 1_000_000 })).toBe(0);
  });
  it('pct <= 0 → 0', () => {
    expect(equityPctToLots(0, { price: 23, multiplier: 1000, equity: 1_000_000 })).toBe(0);
    expect(equityPctToLots(-5, { price: 23, multiplier: 1000, equity: 1_000_000 })).toBe(0);
  });
  it('equity=0 → 0', () => {
    expect(equityPctToLots(5, { price: 23, multiplier: 1000, equity: 0 })).toBe(0);
  });
  it('期貨 20% of 5M @ TXF 17000 → 1M/3.4M = 0', () => {
    expect(equityPctToLots(20, { price: 17000, multiplier: 200, equity: 5_000_000 })).toBe(0);
  });
  it('期貨 80% of 5M @ TXF 17000 → 4M/3.4M = 1 口', () => {
    expect(equityPctToLots(80, { price: 17000, multiplier: 200, equity: 5_000_000 })).toBe(1);
  });
});

describe('lotsToAmount', () => {
  it('台股 4 張 @ 23 → 92,000', () => {
    expect(lotsToAmount(4, { price: 23, multiplier: 1000, equity: 0 })).toBe(92_000);
  });
  it('TXF 1 口 @ 17000 → 3,400,000', () => {
    expect(lotsToAmount(1, { price: 17000, multiplier: 200, equity: 0 })).toBe(3_400_000);
  });
  it('0 lots → 0', () => {
    expect(lotsToAmount(0, { price: 23, multiplier: 1000, equity: 0 })).toBe(0);
  });
});

describe('resolveLots dispatcher', () => {
  const ctx = { price: 23, multiplier: 1000, equity: 1_000_000 };
  it('mode=lots → 直接回 value，clamp to >= 1', () => {
    expect(resolveLots('lots', 3, ctx)).toBe(3);
    expect(resolveLots('lots', 0, ctx)).toBe(1);
    expect(resolveLots('lots', -2, ctx)).toBe(1);
  });
  it('mode=amount → 換算金額', () => {
    expect(resolveLots('amount', 100_000, ctx)).toBe(4);
  });
  it('mode=equity_pct → 換算 %', () => {
    expect(resolveLots('equity_pct', 10, ctx)).toBe(4);
  });
  it('mode=amount，價格上漲後 qty 自動變少', () => {
    expect(resolveLots('amount', 100_000, { ...ctx, price: 23 })).toBe(4);
    expect(resolveLots('amount', 100_000, { ...ctx, price: 30 })).toBe(3);
    expect(resolveLots('amount', 100_000, { ...ctx, price: 50 })).toBe(2);
  });
});
