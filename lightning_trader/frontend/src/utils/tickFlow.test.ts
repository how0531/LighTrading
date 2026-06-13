/**
 * tickFlow 純函式測試（vitest）— Sprint 35
 */
import { describe, it, expect } from 'vitest';
import { classifyAggressor, isBigTrade, summarizeFlow } from './tickFlow';

describe('classifyAggressor', () => {
  it('tickType 1 = 外盤 buy', () => {
    expect(classifyAggressor(1, 100, 99)).toBe('buy');
  });
  it('tickType 2 = 內盤 sell', () => {
    expect(classifyAggressor(2, 100, 101)).toBe('sell');
  });
  it('tickType 明確時不被價格推估覆蓋', () => {
    // tickType=1（外盤）即使價格下跌仍判 buy
    expect(classifyAggressor(1, 99, 100)).toBe('buy');
  });
  it('tickType 0 → 漲判 buy', () => {
    expect(classifyAggressor(0, 101, 100)).toBe('buy');
  });
  it('tickType 0 → 跌判 sell', () => {
    expect(classifyAggressor(0, 99, 100)).toBe('sell');
  });
  it('tickType 0 + 平盤 → neutral', () => {
    expect(classifyAggressor(0, 100, 100)).toBe('neutral');
  });
  it('沒有前一筆價 → neutral', () => {
    expect(classifyAggressor(undefined, 100, undefined)).toBe('neutral');
  });
});

describe('isBigTrade', () => {
  it('達門檻為大單', () => {
    expect(isBigTrade(50, 50)).toBe(true);
    expect(isBigTrade(80, 50)).toBe(true);
  });
  it('未達門檻不是大單', () => {
    expect(isBigTrade(10, 50)).toBe(false);
  });
  it('門檻 <= 0 視為關閉', () => {
    expect(isBigTrade(999, 0)).toBe(false);
    expect(isBigTrade(999, -1)).toBe(false);
  });
});

describe('summarizeFlow', () => {
  it('空陣列 → 全 0、buyPct 50', () => {
    const s = summarizeFlow([]);
    expect(s).toEqual({ buyVol: 0, sellVol: 0, neutralVol: 0, delta: 0, total: 0, buyPct: 50 });
  });

  it('依 tickType 累計買賣量', () => {
    const s = summarizeFlow([
      { price: 100, volume: 3, tickType: 1 }, // buy
      { price: 100, volume: 2, tickType: 2 }, // sell
      { price: 100, volume: 5, tickType: 1 }, // buy
    ]);
    expect(s.buyVol).toBe(8);
    expect(s.sellVol).toBe(2);
    expect(s.delta).toBe(6);
    expect(s.total).toBe(10);
    expect(s.buyPct).toBeCloseTo(80);
  });

  it('tickType 0 用「新到舊」相鄰價格推估', () => {
    // index0 最新(102)，其前一筆是 index1(101) → 漲 → buy
    // index1(101)，前一筆 index2(100) → 漲 → buy
    // index2(100) 無更舊 → neutral
    const s = summarizeFlow([
      { price: 102, volume: 1, tickType: 0 },
      { price: 101, volume: 1, tickType: 0 },
      { price: 100, volume: 1, tickType: 0 },
    ]);
    expect(s.buyVol).toBe(2);
    expect(s.neutralVol).toBe(1);
    expect(s.sellVol).toBe(0);
  });

  it('全中性時 buyPct 退回 50', () => {
    const s = summarizeFlow([{ price: 100, volume: 4, tickType: 0 }]);
    expect(s.neutralVol).toBe(4);
    expect(s.buyPct).toBe(50);
  });
});
