/**
 * layOrders 鋪單價格計算測試（Sprint C）
 *
 * 口徑：買單由起始價往下鋪、賣單往上鋪；每步用「當前價位的 tick 級距」推進
 * （與 DOMPanel ladder 展開一致），起始價先貼齊 tick。
 */
import { describe, it, expect } from 'vitest';
import { computeLayPrices, roundToTick } from './layOrders';

describe('roundToTick', () => {
  it('期貨（tick=1）：貼齊整數', () => {
    expect(roundToTick(20000.4, 'TXFR1')).toBe(20000);
    expect(roundToTick(20000.6, 'TXFR1')).toBe(20001);
  });

  it('台股 <100（tick=0.10）：貼齊 0.1', () => {
    expect(roundToTick(99.93, '2330')).toBe(99.9);
    expect(roundToTick(99.97, '2330')).toBe(100);
  });
});

describe('computeLayPrices', () => {
  it('買單往下鋪：期貨 3 檔 / 間距 1 tick', () => {
    expect(computeLayPrices({
      side: 'Buy', levels: 3, startPrice: 20000, gapTicks: 1, symbol: 'TXFR1',
    })).toEqual([20000, 19999, 19998]);
  });

  it('賣單往上鋪：期貨 4 檔 / 間距 2 tick', () => {
    expect(computeLayPrices({
      side: 'Sell', levels: 4, startPrice: 20000, gapTicks: 2, symbol: 'TXFR1',
    })).toEqual([20000, 20002, 20004, 20006]);
  });

  it('台股買單：0.1 tick 區間內往下鋪且無浮點漂移', () => {
    expect(computeLayPrices({
      side: 'Buy', levels: 3, startPrice: 99, gapTicks: 1, symbol: '2330',
    })).toEqual([99, 98.9, 98.8]);
  });

  it('起始價未對齊 tick：先貼齊再展開', () => {
    expect(computeLayPrices({
      side: 'Buy', levels: 2, startPrice: 99.93, gapTicks: 1, symbol: '2330',
    })).toEqual([99.9, 99.8]);
  });

  it('賣單跨 tick 級距邊界：99.9 → 100（0.1）→ 100.5（0.5），與 ladder 口徑一致', () => {
    expect(computeLayPrices({
      side: 'Sell', levels: 3, startPrice: 99.9, gapTicks: 1, symbol: '2330',
    })).toEqual([99.9, 100, 100.5]);
  });

  it('N 檔數量正確（10 檔上限情境）', () => {
    const prices = computeLayPrices({
      side: 'Sell', levels: 10, startPrice: 20000, gapTicks: 1, symbol: 'MXFR1',
    });
    expect(prices).toHaveLength(10);
    expect(prices[9]).toBe(20009);
  });

  it('防禦：無效起始價 / 檔數 → 空陣列；gapTicks 最小取 1', () => {
    expect(computeLayPrices({ side: 'Buy', levels: 3, startPrice: 0, gapTicks: 1, symbol: 'TXFR1' })).toEqual([]);
    expect(computeLayPrices({ side: 'Buy', levels: 0, startPrice: 100, gapTicks: 1, symbol: 'TXFR1' })).toEqual([]);
    expect(computeLayPrices({
      side: 'Buy', levels: 2, startPrice: 20000, gapTicks: 0, symbol: 'TXFR1',
    })).toEqual([20000, 19999]);
  });

  it('防禦：買單往下鋪到穿零前停止', () => {
    const prices = computeLayPrices({
      side: 'Buy', levels: 10, startPrice: 0.03, gapTicks: 1, symbol: '1101',
    });
    expect(prices).toEqual([0.03, 0.02, 0.01]);
  });
});
