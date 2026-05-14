import { describe, it, expect } from 'vitest';
import { shouldTrigger, findTriggered } from './priceAlerts';
import type { PriceAlert } from '../contexts/SettingsContext';

const A = (over: Partial<PriceAlert>): PriceAlert => ({
  id: 'a1', symbol: 'TXFR1', op: 'above', price: 17000, enabled: true,
  ...over,
});

describe('shouldTrigger', () => {
  it('above: prev < price < curr → trigger', () => {
    expect(shouldTrigger(A({}), 16990, 17005)).toBe(true);
  });

  it('above: prev < price, curr exactly = price → trigger', () => {
    expect(shouldTrigger(A({}), 16990, 17000)).toBe(true);
  });

  it('above: prev already >= price → no trigger (already crossed)', () => {
    expect(shouldTrigger(A({}), 17050, 17100)).toBe(false);
  });

  it('below: prev > price > curr → trigger', () => {
    expect(shouldTrigger(A({ op: 'below' }), 17050, 16990)).toBe(true);
  });

  it('below: still above price → no trigger', () => {
    expect(shouldTrigger(A({ op: 'below' }), 17050, 17020)).toBe(false);
  });

  it('disabled → no trigger', () => {
    expect(shouldTrigger(A({ enabled: false }), 16990, 17010)).toBe(false);
  });

  it('already triggered → no trigger', () => {
    expect(shouldTrigger(A({ triggeredAt: 12345 }), 16990, 17010)).toBe(false);
  });

  it('prev=0 (first observation) → no trigger', () => {
    expect(shouldTrigger(A({}), 0, 17005)).toBe(false);
  });
});

describe('findTriggered', () => {
  it('filters by symbol case-insensitively', () => {
    const alerts: PriceAlert[] = [
      A({ id: '1', symbol: 'TXFR1' }),
      A({ id: '2', symbol: 'MXFR1' }),
      A({ id: '3', symbol: 'txfr1' }),  // 小寫
    ];
    const ids = findTriggered(alerts, 'TXFR1', 16990, 17010);
    expect(ids).toEqual(['1', '3']);
  });

  it('skips alerts that match symbol but condition not met', () => {
    const alerts: PriceAlert[] = [
      A({ id: '1', op: 'above', price: 17000 }),
      A({ id: '2', op: 'above', price: 17200 }),  // 還沒到
    ];
    expect(findTriggered(alerts, 'TXFR1', 16990, 17010)).toEqual(['1']);
  });
});
