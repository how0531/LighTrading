import { describe, it, expect } from 'vitest';
import { roundTripCost, netPnL, DEFAULT_FEE_CONFIG, isStockMultiplier } from './fees';

const cfg = DEFAULT_FEE_CONFIG;

describe('isStockMultiplier', () => {
  it('1000 = 股票', () => expect(isStockMultiplier(1000)).toBe(true));
  it('200 (TXF) = 非股票', () => expect(isStockMultiplier(200)).toBe(false));
});

describe('roundTripCost — 股票', () => {
  it('2330 @ 1000→1010, 1 張 (multiplier=1000)', () => {
    // notionalIn = 1000*1*1000 = 1,000,000；notionalOut = 1,010,000
    // feeRate = 0.1425% × 1 = 0.001425
    // feeIn  = 1,000,000 × 0.001425 = 1425
    // feeOut = 1,010,000 × 0.001425 = 1439.25
    // tax    = 1,010,000 × 0.3%   = 3030
    // total  = round(1425 + 1439.25 + 3030) = 5894
    expect(roundTripCost('2330', 1, 1000, 1010, cfg)).toBe(5894);
  });
  it('當沖賣稅減半', () => {
    const day = { ...cfg, stockDayTrade: true };
    // tax = 1,010,000 × 0.15% = 1515 → total = round(1425 + 1439.25 + 1515) = 4379
    expect(roundTripCost('2330', 1, 1000, 1010, day)).toBe(4379);
  });
  it('折數套用：2.8 折手續費減少', () => {
    const disc = { ...cfg, stockFeeDiscount: 0.28 };
    // feeIn  = 1,000,000 × 0.001425 × 0.28 = 399
    // feeOut = 1,010,000 × 0.001425 × 0.28 = 402.99
    // tax    = 3030
    // total  = round(399 + 402.99 + 3030) = 3832
    expect(roundTripCost('2330', 1, 1000, 1010, disc)).toBe(3832);
  });
  it('低消生效：低價股 1 張手續費不足 20 補到 20', () => {
    // price 10, 1 張：notional = 10*1*1000 = 10,000
    // fee = 10,000 × 0.001425 = 14.25 < 20 → 補 20（兩邊）
    // tax = 10,000 × 0.3% = 30
    // total = round(20 + 20 + 30) = 70
    expect(roundTripCost('1234', 1, 10, 10, cfg)).toBe(70);
  });
});

describe('roundTripCost — 期貨', () => {
  it('TXF (大台, multiplier=200) 1 口 17000→17010', () => {
    // fee = 40 × 1 × 2 = 80
    // notionalIn = 17000*1*200 = 3,400,000；out = 3,402,000
    // tax = (3,400,000 + 3,402,000) × 0.002% = 6,802,000 × 0.00002 = 136.04
    // total = round(80 + 136.04) = 216
    expect(roundTripCost('TXFR1', 1, 17000, 17010, cfg)).toBe(216);
  });
  it('MXF (小台, multiplier=50) 2 口', () => {
    // fee = 40 × 2 × 2 = 160
    // notionalIn = 17000*2*50 = 1,700,000；out = 1,701,000
    // tax = 3,401,000 × 0.00002 = 68.02
    // total = round(160 + 68.02) = 228
    expect(roundTripCost('MXFR1', 2, 17000, 17010, cfg)).toBe(228);
  });
});

describe('roundTripCost — 邊界', () => {
  it('qty=0 → 0', () => expect(roundTripCost('2330', 0, 1000, 1010, cfg)).toBe(0));
  it('entryPrice=0 → 0', () => expect(roundTripCost('2330', 1, 0, 1010, cfg)).toBe(0));
  it('exitPrice=0 → 0', () => expect(roundTripCost('2330', 1, 1000, 0, cfg)).toBe(0));
});

describe('netPnL', () => {
  it('股票毛賺 10000，扣成本後變淨', () => {
    const cost = roundTripCost('2330', 1, 1000, 1010, cfg); // 5894
    expect(netPnL(10000, '2330', 1, 1000, 1010, cfg)).toBe(10000 - cost);
  });
  it('毛賺被成本吃光變負（手續費殺手）', () => {
    // 期貨小賺 100 點以下，扣成本可能轉負
    const n = netPnL(100, 'TXFR1', 1, 17000, 17010, cfg);
    expect(n).toBe(100 - 216);
    expect(n).toBeLessThan(0);
  });
  it('成本為 0 時淨=毛', () => {
    expect(netPnL(5000, '2330', 0, 1000, 1010, cfg)).toBe(5000);
  });
});
