/**
 * depthHeatmap 純函式測試（Sprint D）
 *
 * 重點：
 *  1. ring buffer 上限：超過 cap 丟最舊、順序恆為 oldest → newest
 *  2. 價格帶：中價對齊 tick 網格、隨中價平移；同一 tick 內的微幅波動不平移
 *  3. priceToRow：就近取整映射、超出視窗回 -1
 *  4. rolling max：跨快照取所有檔位最大量；空資料除零保護
 *  5. 對數強度：0 量 → 0、max → 1、單調遞增、尖峰耐受（半量強度 > 線性的 0.5）
 */
import { describe, it, expect } from 'vitest';
import {
  createDepthRing, pushDepthSnapshot, clearDepthRing,
  alignToTick, buildPriceBand, priceToRow, rowToPrice,
  rollingMaxVolume, logIntensity,
  type DepthSnapshot,
} from './depthHeatmap';

function snap(partial: Partial<DepthSnapshot> = {}): DepthSnapshot {
  return {
    time: 0,
    bidPrices: [], bidVols: [],
    askPrices: [], askVols: [],
    price: 0,
    ...partial,
  };
}

describe('depthHeatmap ring buffer', () => {
  it('超過 cap 丟最舊、順序 oldest → newest', () => {
    const ring = createDepthRing(3);
    for (let i = 1; i <= 5; i++) pushDepthSnapshot(ring, snap({ time: i }));
    expect(ring.snaps).toHaveLength(3);
    expect(ring.snaps.map((s) => s.time)).toEqual([3, 4, 5]);
  });

  it('未達 cap 全數保留；clear 清空但保留容量', () => {
    const ring = createDepthRing(10);
    pushDepthSnapshot(ring, snap({ time: 1 }));
    pushDepthSnapshot(ring, snap({ time: 2 }));
    expect(ring.snaps.map((s) => s.time)).toEqual([1, 2]);
    clearDepthRing(ring);
    expect(ring.snaps).toHaveLength(0);
    expect(ring.cap).toBe(10);
  });

  it('cap 至少為 1（非法輸入防呆）', () => {
    const ring = createDepthRing(0);
    pushDepthSnapshot(ring, snap({ time: 1 }));
    pushDepthSnapshot(ring, snap({ time: 2 }));
    expect(ring.snaps).toHaveLength(1);
    expect(ring.snaps[0].time).toBe(2);
  });
});

describe('depthHeatmap 價格帶', () => {
  it('alignToTick：對齊到最近的 tick 倍數（含浮點漂移防護）', () => {
    expect(alignToTick(100.03, 0.05)).toBe(100.05);
    expect(alignToTick(100.02, 0.05)).toBe(100);
    expect(alignToTick(17554.4, 1)).toBe(17554);
    // 0.1 tick 的典型浮點陷阱：29.7 / 0.1 = 296.99999…
    expect(alignToTick(29.7, 0.1)).toBe(29.7);
  });

  it('buildPriceBand：top = 對齊後中價 + halfTicks*tick、rowCount = 2*halfTicks+1', () => {
    const band = buildPriceBand(1000, 1, 12);
    expect(band).not.toBeNull();
    expect(band!.top).toBe(1012);
    expect(band!.rowCount).toBe(25);
    // 中央列（row = halfTicks）就是對齊後的中價
    expect(rowToPrice(12, band!)).toBe(1000);
    expect(rowToPrice(24, band!)).toBe(988);
  });

  it('視窗隨中價平移：中價 +3 tick → 同一價位的列索引 +3', () => {
    const b1 = buildPriceBand(500, 0.5, 12)!;
    const b2 = buildPriceBand(501.5, 0.5, 12)!;
    expect(priceToRow(500, b1)).toBe(12);
    expect(priceToRow(500, b2)).toBe(15);
  });

  it('同一 tick 內的微幅波動不平移（中價先對齊網格）', () => {
    const b1 = buildPriceBand(100.02, 0.05, 10)!;
    const b2 = buildPriceBand(100.01, 0.05, 10)!;
    expect(b1.top).toBe(b2.top); // 兩者都對齊到 100.00
  });

  it('無效輸入回 null', () => {
    expect(buildPriceBand(0, 1, 12)).toBeNull();
    expect(buildPriceBand(100, 0, 12)).toBeNull();
    expect(buildPriceBand(100, 1, -1)).toBeNull();
  });
});

describe('depthHeatmap priceToRow 映射', () => {
  const band = buildPriceBand(100, 0.5, 4)!; // top=102, rows=9（102…98）

  it('網格上的價位映射到正確列', () => {
    expect(priceToRow(102, band)).toBe(0);
    expect(priceToRow(100, band)).toBe(4);
    expect(priceToRow(98, band)).toBe(8);
  });

  it('偏離網格的價位就近取整（跨級距邊界容忍）', () => {
    expect(priceToRow(100.2, band)).toBe(4);  // 距 100 較近（0.2 < 0.3）
    expect(priceToRow(100.3, band)).toBe(3);  // 距 100.5 較近
  });

  it('超出視窗或無效價回 -1', () => {
    expect(priceToRow(102.5, band)).toBe(-1);
    expect(priceToRow(97.4, band)).toBe(-1);
    expect(priceToRow(0, band)).toBe(-1);
  });
});

describe('depthHeatmap rolling max / 對數強度', () => {
  it('rollingMaxVolume：跨快照、跨買賣側取最大掛量', () => {
    const snaps = [
      snap({ bidVols: [10, 5], askVols: [3] }),
      snap({ bidVols: [2], askVols: [99, 1] }),
      snap({ bidVols: [], askVols: [] }),
    ];
    expect(rollingMaxVolume(snaps)).toBe(99);
  });

  it('rollingMaxVolume：無資料 / 全零回 1（除零保護）', () => {
    expect(rollingMaxVolume([])).toBe(1);
    expect(rollingMaxVolume([snap({ bidVols: [0], askVols: [0] })])).toBe(1);
  });

  it('logIntensity：0 量 → 0、max → 1、單調遞增、封頂 1', () => {
    expect(logIntensity(0, 100)).toBe(0);
    expect(logIntensity(-5, 100)).toBe(0);
    expect(logIntensity(100, 100)).toBeCloseTo(1, 10);
    expect(logIntensity(999, 100)).toBe(1); // 超過 max 也封頂
    const i10 = logIntensity(10, 100);
    const i50 = logIntensity(50, 100);
    expect(i10).toBeGreaterThan(0);
    expect(i50).toBeGreaterThan(i10);
    expect(i50).toBeLessThan(1);
  });

  it('對數縮放的尖峰耐受：max 出現巨量時，中等掛量仍有可視強度（> 線性比例）', () => {
    // 線性縮放下 50/10000 = 0.005（幾乎看不見）；對數下應顯著高於它
    const linear = 50 / 10000;
    const log = logIntensity(50, 10000);
    expect(log).toBeGreaterThan(linear * 10);
    expect(log).toBeGreaterThan(0.4); // log1p(50)/log1p(10000) ≈ 0.427
  });
});
