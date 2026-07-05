/**
 * Sprint E 指標運算庫測試
 *
 * Golden values（手算已知數列）：MACD / KD / ATR / SuperTrend / BBANDS(補充)
 * （SMA/EMA/RSI/BBANDS 的 golden 基準在 indicators.test.ts,此處補 aligned 版 parity）
 * 其餘指標：形狀 / 邊界（暖身 NaN 略過、資料不足回空、單根不崩）。
 */
import { describe, it, expect } from 'vitest';
import {
  type Candle,
  alignedSMA, alignedEMA, alignedWMA, alignedStdev, alignedHighest, alignedLowest,
  alignedChange, alignedROC, alignedRSI, alignedTR, alignedATRFromBars,
  alignedCrossover, alignedCrossunder,
  computeSMA, computeEMA, computeRSI, computeBollinger,
  computeWMA, computeDonchian, computeKeltner, computePSAR, computeSuperTrend,
  computeVWAPDaily, computeEnvelope, computeMACD, computeKD, computeATR,
  computeCCI, computeOBV, computeWilliamsR, computeMFI, computeROC, computeDMI,
  computeVolumeMA, taipeiDayKey,
  TREND_UP_COLOR, TREND_DOWN_COLOR,
} from './indicators';

/** 快速 bar：h=l=o=c（除非指定） */
const B = (t: number, c: number, v = 0): Candle => ({
  time: t, open: c, high: c, low: c, close: c, volume: v,
});
/** 完整 bar */
const HLC = (t: number, h: number, l: number, c: number, v = 0, o = c): Candle => ({
  time: t, open: o, high: h, low: l, close: c, volume: v,
});

const times = (pts: Array<{ time: number }>) => pts.map((p) => p.time);
const values = (pts: Array<{ value: number }>) => pts.map((p) => p.value);

/* ══ aligned 核心 ══════════════════════════════════════ */

describe('aligned 核心（ta 層）', () => {
  it('alignedSMA：暖身 NaN + 數值與 computeSMA 一致', () => {
    const closes = [10, 20, 30, 40, 50];
    const a = alignedSMA(closes, 3);
    expect(a.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(a.slice(2)).toEqual([20, 30, 40]);
    const bars = closes.map((c, i) => B(i + 1, c));
    expect(a.slice(2)).toEqual(values(computeSMA(bars, 3)));
  });

  it('alignedSMA：視窗含 NaN → 該點 NaN；period<=0 → 全 NaN', () => {
    const a = alignedSMA([1, NaN, 3, 4, 5], 2);
    expect(Number.isNaN(a[1])).toBe(true);
    expect(Number.isNaN(a[2])).toBe(true); // 視窗 [NaN,3]
    expect(a[3]).toBeCloseTo(3.5, 10);
    expect(alignedSMA([1, 2, 3], 0).every(Number.isNaN)).toBe(true);
  });

  it('alignedEMA：與 computeEMA 一致；前緣 NaN 自動跳過', () => {
    const closes = [10, 11, 13, 14, 12, 15, 16];
    const bars = closes.map((c, i) => B(i + 1, c));
    const a = alignedEMA(closes, 3);
    const legacy = computeEMA(bars, 3);
    expect(a.filter(Number.isFinite)).toEqual(values(legacy));
    // 前緣 NaN（模擬串接暖身輸出）
    const chained = alignedEMA([NaN, NaN, 10, 20, 30, 40], 2);
    expect(chained.slice(0, 3).every(Number.isNaN)).toBe(true);
    expect(chained[3]).toBeCloseTo(15, 10);   // seed = (10+20)/2
  });

  it('alignedRSI：與 computeRSI 一致', () => {
    const closes = [44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84];
    const bars = closes.map((c, i) => B(i + 1, c));
    const a = alignedRSI(closes, 5);
    const legacy = computeRSI(bars, 5);
    const finite = a.map((v, i) => ({ i, v })).filter((x) => Number.isFinite(x.v));
    expect(finite.length).toBe(legacy.length);
    finite.forEach((x, k) => expect(x.v).toBeCloseTo(legacy[k].value, 10));
  });

  it('alignedWMA golden：權重 1..p（最近最大）', () => {
    const a = alignedWMA([10, 20, 30, 40], 3);
    expect(Number.isNaN(a[0]) && Number.isNaN(a[1])).toBe(true);
    expect(a[2]).toBeCloseTo((10 * 1 + 20 * 2 + 30 * 3) / 6, 10);  // 70/3
    expect(a[3]).toBeCloseTo((20 * 1 + 30 * 2 + 40 * 3) / 6, 10);  // 100/3
  });

  it('alignedStdev：母體標準差,與 Bollinger 的 σ 約定一致', () => {
    const a = alignedStdev([10, 12, 14, 16], 3);
    expect(a[2]).toBeCloseTo(Math.sqrt(8 / 3), 10);
    expect(a[3]).toBeCloseTo(Math.sqrt(8 / 3), 10);
  });

  it('alignedHighest / alignedLowest / alignedChange / alignedROC', () => {
    expect(alignedHighest([1, 5, 3, 4], 2).slice(1)).toEqual([5, 5, 4]);
    expect(alignedLowest([1, 5, 3, 4], 2).slice(1)).toEqual([1, 3, 3]);
    expect(alignedChange([10, 15, 12], 1).slice(1)).toEqual([5, -3]);
    const roc = alignedROC([10, 20, 40], 1);
    expect(roc[1]).toBeCloseTo(100, 10);
    expect(roc[2]).toBeCloseTo(100, 10);
    expect(alignedROC([10, 20, 40], 2)[2]).toBeCloseTo(300, 10);
    // 分母 0 → NaN
    expect(Number.isNaN(alignedROC([0, 5], 1)[1])).toBe(true);
  });

  it('alignedTR / alignedATRFromBars（Wilder,SMA 起種）', () => {
    const bars = [
      HLC(1, 12, 8, 10), HLC(2, 15, 9, 14), HLC(3, 16, 13, 15),
      HLC(4, 18, 14, 17), HLC(5, 17, 13, 14),
    ];
    expect(alignedTR(bars)).toEqual([4, 6, 3, 4, 4]);
    const atr = alignedATRFromBars(bars, 3);
    expect(Number.isNaN(atr[0]) && Number.isNaN(atr[1])).toBe(true);
    expect(atr[2]).toBeCloseTo(13 / 3, 10);
    expect(atr[3]).toBeCloseTo(38 / 9, 10);
    expect(atr[4]).toBeCloseTo(112 / 27, 10);
  });

  it('alignedCrossover / alignedCrossunder', () => {
    expect(alignedCrossover([1, 2, 3], [2, 2, 2])).toEqual([false, false, true]);
    expect(alignedCrossunder([3, 2, 1], [2, 2, 2])).toEqual([false, false, true]);
    // NaN 邊界不觸發
    expect(alignedCrossover([NaN, 3], [2, 2])[1]).toBe(false);
  });
});

/* ══ Golden：MACD / KD / ATR / SuperTrend / BBANDS ══════ */

describe('computeMACD golden（fast=2, slow=3, signal=2）', () => {
  const bars = [10, 20, 15, 25, 20, 30].map((c, i) => B(i + 1, c));
  const m = computeMACD(bars, 2, 3, 2);

  it('DIF = EMA2 − EMA3,自 slow 暖身完起', () => {
    expect(times(m.dif)).toEqual([3, 4, 5, 6]);
    expect(m.dif[0].value).toBeCloseTo(0, 10);
    expect(m.dif[1].value).toBeCloseTo(5 / 3, 10);
    expect(m.dif[2].value).toBeCloseTo(5 / 9, 10);
    expect(m.dif[3].value).toBeCloseTo(50 / 27, 10);
  });

  it('DEA = EMA(DIF, 2)（SMA 起種於 DIF 前 2 值）', () => {
    expect(times(m.dea)).toEqual([4, 5, 6]);
    expect(m.dea[0].value).toBeCloseTo(5 / 6, 10);
    expect(m.dea[1].value).toBeCloseTo(35 / 54, 10);
    expect(m.dea[2].value).toBeCloseTo(235 / 162, 10);
  });

  it('OSC 柱 = DIF − DEA,正紅負綠', () => {
    expect(times(m.hist)).toEqual([4, 5, 6]);
    expect(m.hist[0].value).toBeCloseTo(5 / 6, 10);
    expect(m.hist[1].value).toBeCloseTo(-5 / 54, 10);
    expect(m.hist[2].value).toBeCloseTo(65 / 162, 10);
    expect(m.hist[0].color).toMatch(/239, 68, 68/);   // 正 → 紅
    expect(m.hist[1].color).toMatch(/16, 185, 129/);  // 負 → 綠
  });

  it('資料不足 / 空資料 / 單根不崩', () => {
    expect(computeMACD([], 2, 3, 2)).toEqual({ dif: [], dea: [], hist: [] });
    const one = computeMACD([B(1, 10)], 2, 3, 2);
    expect(one.dif).toEqual([]);
    expect(one.dea).toEqual([]);
  });
});

describe('computeKD golden（period=3, smooth=3/3,台股慣例 K=2/3K+1/3RSV）', () => {
  const bars = [
    HLC(1, 10, 0, 5), HLC(2, 10, 0, 8), HLC(3, 10, 0, 9), HLC(4, 10, 0, 2),
  ];
  const { k, d } = computeKD(bars, 3, 3, 3);

  it('K/D 遞迴（初始 50）手算驗證', () => {
    expect(times(k)).toEqual([3, 4]);
    expect(k[0].value).toBeCloseTo(190 / 3, 10);    // (50*2 + 90)/3
    expect(d[0].value).toBeCloseTo(490 / 9, 10);    // (50*2 + 190/3)/3
    expect(k[1].value).toBeCloseTo(440 / 9, 10);    // (190/3*2 + 20)/3
    expect(d[1].value).toBeCloseTo(1420 / 27, 10);  // (490/9*2 + 440/9)/3
  });

  it('HHV = LLV → RSV 取 50（中性）', () => {
    const flat = [B(1, 10), B(2, 10), B(3, 10)];
    const r = computeKD(flat, 3, 1, 1);  // smooth=1 → K=RSV
    expect(r.k[0].value).toBe(50);
  });

  it('邊界：資料不足回空、單根不崩、period<=0 回空', () => {
    expect(computeKD([B(1, 5)], 3).k).toEqual([]);
    expect(computeKD([], 9).k).toEqual([]);
    expect(computeKD([B(1, 5), B(2, 6)], 0).k).toEqual([]);
  });
});

describe('computeATR golden（period=3,Wilder）', () => {
  it('SMA 起種 + Wilder smoothing 手算驗證', () => {
    const bars = [
      HLC(1, 12, 8, 10), HLC(2, 15, 9, 14), HLC(3, 16, 13, 15),
      HLC(4, 18, 14, 17), HLC(5, 17, 13, 14),
    ];
    const atr = computeATR(bars, 3);
    expect(times(atr)).toEqual([3, 4, 5]);
    expect(atr[0].value).toBeCloseTo(13 / 3, 10);
    expect(atr[1].value).toBeCloseTo(38 / 9, 10);
    expect(atr[2].value).toBeCloseTo(112 / 27, 10);
  });

  it('邊界：不足回空、單根不崩', () => {
    expect(computeATR([], 3)).toEqual([]);
    expect(computeATR([HLC(1, 12, 8, 10)], 3)).toEqual([]);
    // 單根 + period=1 → TR = h-l
    expect(computeATR([HLC(1, 12, 8, 10)], 1)).toEqual([{ time: 1, value: 4 }]);
  });
});

describe('computeSuperTrend golden（period=2, mult=1）', () => {
  const bars = [
    HLC(1, 12, 8, 10), HLC(2, 13, 9, 12), HLC(3, 14, 10, 13),
    HLC(4, 11, 7, 7.5), HLC(5, 10, 6, 9),
  ];
  const st = computeSuperTrend(bars, 2, 1);

  it('final 軌道遞迴 + 趨勢翻轉手算驗證', () => {
    expect(times(st)).toEqual([2, 3, 4, 5]);
    expect(values(st)).toEqual([7, 8, 14, 12.5]);
  });

  it('趨勢配色：多方紅(下軌)/空方綠(上軌)', () => {
    expect(st[0].color).toBe(TREND_UP_COLOR);
    expect(st[1].color).toBe(TREND_UP_COLOR);
    expect(st[2].color).toBe(TREND_DOWN_COLOR);  // close 7.5 跌破下軌 8 → 翻空
    expect(st[3].color).toBe(TREND_DOWN_COLOR);
  });

  it('邊界：不足回空、單根不崩', () => {
    expect(computeSuperTrend([], 10, 3)).toEqual([]);
    expect(computeSuperTrend([HLC(1, 12, 8, 10)], 10, 3)).toEqual([]);
  });
});

describe('computeBollinger 補充 golden（σ 為母體標準差）', () => {
  it('period=3, mult=2 手算', () => {
    const bars = [10, 12, 14, 16].map((c, i) => B(i + 1, c));
    const { upper, middle, lower } = computeBollinger(bars, 3, 2);
    const sigma = Math.sqrt(8 / 3);
    expect(values(middle)).toEqual([12, 14]);
    expect(upper[0].value).toBeCloseTo(12 + 2 * sigma, 10);
    expect(lower[1].value).toBeCloseTo(14 - 2 * sigma, 10);
  });
});

/* ══ 其他指標：形狀 / 邊界 ══════════════════════════════ */

describe('computeWMA', () => {
  it('golden：權重 1..p', () => {
    const bars = [1, 2, 3].map((c, i) => B(i + 1, c));
    const w = computeWMA(bars, 3);
    expect(w).toEqual([{ time: 3, value: 14 / 6 }]);
  });
  it('邊界：不足回空、單根不崩', () => {
    expect(computeWMA([], 3)).toEqual([]);
    expect(computeWMA([B(1, 10)], 3)).toEqual([]);
    expect(computeWMA([B(1, 10)], 1)).toEqual([{ time: 1, value: 10 }]);
  });
});

describe('computeDonchian', () => {
  it('golden：視窗最高/最低/中值', () => {
    const bars = [HLC(1, 3, 1, 2), HLC(2, 5, 2, 3), HLC(3, 4, 0, 2)];
    const d = computeDonchian(bars, 2);
    expect(values(d.upper)).toEqual([5, 5]);
    expect(values(d.lower)).toEqual([1, 0]);
    expect(values(d.middle)).toEqual([3, 2.5]);
    expect(times(d.upper)).toEqual([2, 3]);
  });
  it('邊界', () => {
    expect(computeDonchian([], 20).upper).toEqual([]);
    expect(computeDonchian([HLC(1, 3, 1, 2)], 20).upper).toEqual([]);
  });
});

describe('computeKeltner', () => {
  it('關係式：mid = EMA(close)、上下 = mid ± mult×ATR', () => {
    const bars = Array.from({ length: 30 }, (_, i) =>
      HLC(i + 1, 102 + Math.sin(i) * 2, 98 + Math.sin(i) * 2, 100 + Math.sin(i) * 2));
    const kc = computeKeltner(bars, 5, 3, 2);
    const ema = alignedEMA(bars.map((b) => b.close), 5);
    const atr = alignedATRFromBars(bars, 3);
    expect(kc.middle.length).toBeGreaterThan(0);
    // 每個 upper 點 = 同 time 的 mid + 2×ATR
    for (const up of kc.upper) {
      const idx = up.time - 1;
      expect(up.value).toBeCloseTo(ema[idx] + 2 * atr[idx], 10);
    }
    for (let i = 0; i < kc.upper.length; i++) {
      expect(kc.upper[i].value).toBeGreaterThanOrEqual(kc.lower[i].value);
    }
  });
  it('邊界：不足回空、單根不崩', () => {
    expect(computeKeltner([], 20, 10, 2).middle).toEqual([]);
    expect(computeKeltner([HLC(1, 3, 1, 2)], 20, 10, 2).middle).toEqual([]);
  });
});

describe('computePSAR', () => {
  it('上升趨勢：SAR 始終低於當根 low（多方紅）', () => {
    const bars = Array.from({ length: 10 }, (_, i) => HLC(i + 1, 11 + i * 10, 9 + i * 10, 10 + i * 10));
    const sar = computePSAR(bars);
    expect(sar.length).toBe(9);
    sar.forEach((pt) => {
      const bar = bars[pt.time - 1];
      expect(pt.value).toBeLessThan(bar.low);
      expect(pt.color).toBe(TREND_UP_COLOR);
    });
  });
  it('下降趨勢：SAR 高於當根 high（空方綠）', () => {
    const bars = Array.from({ length: 10 }, (_, i) => HLC(i + 1, 101 - i * 10, 99 - i * 10, 100 - i * 10));
    const sar = computePSAR(bars);
    sar.forEach((pt) => {
      const bar = bars[pt.time - 1];
      expect(pt.value).toBeGreaterThan(bar.high);
      expect(pt.color).toBe(TREND_DOWN_COLOR);
    });
  });
  it('邊界：空/單根回空、參數不合法回空', () => {
    expect(computePSAR([])).toEqual([]);
    expect(computePSAR([HLC(1, 11, 9, 10)])).toEqual([]);
    expect(computePSAR([HLC(1, 11, 9, 10), HLC(2, 12, 10, 11)], 0)).toEqual([]);
    expect(computePSAR([HLC(1, 11, 9, 10), HLC(2, 12, 10, 11)], 0.1, 0.05)).toEqual([]);
  });
});

describe('computeVWAPDaily（日內錨定,台北 UTC+8 日切）', () => {
  it('跨日重置累計', () => {
    const bars = [B(0, 10, 1), B(60, 20, 1), B(86400, 30, 1), B(86460, 50, 1)];
    const v = computeVWAPDaily(bars);
    expect(values(v)).toEqual([10, 15, 30, 40]);
  });
  it('同日不重置；量 0 的前緣不出點', () => {
    const sameDay = computeVWAPDaily([B(0, 10, 1), B(60, 20, 1), B(120, 30, 1)]);
    expect(values(sameDay)).toEqual([10, 15, 20]);
    expect(computeVWAPDaily([B(0, 10, 0)])).toEqual([]);
    expect(computeVWAPDaily([])).toEqual([]);
  });
  it('taipeiDayKey：UTC+8 邊界', () => {
    // unix 57600 = UTC 16:00 = 台北 00:00（隔日）
    expect(taipeiDayKey(57599)).toBe(0);
    expect(taipeiDayKey(57600)).toBe(1);
  });
});

describe('computeEnvelope', () => {
  it('golden：SMA ± pct%', () => {
    const bars = [1, 2, 3].map((c, i) => B(i + 1, c));
    const e = computeEnvelope(bars, 2, 10);
    expect(values(e.middle)).toEqual([1.5, 2.5]);
    expect(e.upper[0].value).toBeCloseTo(1.65, 10);
    expect(e.lower[1].value).toBeCloseTo(2.25, 10);
  });
  it('邊界', () => {
    expect(computeEnvelope([], 20, 2.5).middle).toEqual([]);
    expect(computeEnvelope([B(1, 10)], 20, 2.5).middle).toEqual([]);
  });
});

describe('computeCCI', () => {
  it('穩定趨勢（等差）→ 100；常數 → 0（偏差 0 防除零）', () => {
    const trend = [1, 2, 3, 4, 5].map((c, i) => B(i + 1, c));
    computeCCI(trend, 3).forEach((pt) => expect(pt.value).toBeCloseTo(100, 10));
    const flat = Array.from({ length: 5 }, (_, i) => B(i + 1, 7));
    computeCCI(flat, 3).forEach((pt) => expect(pt.value).toBe(0));
  });
  it('邊界', () => {
    expect(computeCCI([], 20)).toEqual([]);
    expect(computeCCI([B(1, 10)], 20)).toEqual([]);
  });
});

describe('computeOBV', () => {
  it('golden：收漲加量/收跌減量/平盤不動,自 0 起', () => {
    const closes = [10, 12, 11, 11, 13];
    const vols = [100, 200, 300, 400, 500];
    const bars = closes.map((c, i) => B(i + 1, c, vols[i]));
    expect(values(computeOBV(bars))).toEqual([0, 200, -100, -100, 400]);
  });
  it('邊界：空回空、單根 = [0]', () => {
    expect(computeOBV([])).toEqual([]);
    expect(computeOBV([B(1, 10, 5)])).toEqual([{ time: 1, value: 0 }]);
  });
});

describe('computeWilliamsR', () => {
  it('golden：收在最高 → 0、線性內插；HHV=LLV → −50', () => {
    const bars = [HLC(1, 10, 0, 5), HLC(2, 12, 2, 12), HLC(3, 8, 4, 4)];
    const w = computeWilliamsR(bars, 2);
    expect(w[0].value).toBeCloseTo(0, 10);
    expect(w[1].value).toBeCloseTo(-80, 10);
    const flat = computeWilliamsR([B(1, 5), B(2, 5)], 2);
    expect(flat[0].value).toBe(-50);
  });
  it('範圍 [−100, 0] 且邊界回空', () => {
    const bars = Array.from({ length: 30 }, (_, i) => HLC(i + 1, 10 + Math.sin(i) * 3, 5 + Math.sin(i) * 3, 7 + Math.sin(i * 2) * 2));
    computeWilliamsR(bars, 5).forEach((pt) => {
      expect(pt.value).toBeLessThanOrEqual(0);
      expect(pt.value).toBeGreaterThanOrEqual(-100);
    });
    expect(computeWilliamsR([B(1, 5)], 14)).toEqual([]);
  });
});

describe('computeMFI', () => {
  it('全升 → 100、全跌 → 0、全平 → 50', () => {
    const up = [10, 20, 30].map((c, i) => B(i + 1, c, 1));
    expect(computeMFI(up, 2)).toEqual([{ time: 3, value: 100 }]);
    const down = [30, 20, 10].map((c, i) => B(i + 1, c, 1));
    expect(computeMFI(down, 2)).toEqual([{ time: 3, value: 0 }]);
    const flat = [10, 10, 10].map((c, i) => B(i + 1, c, 1));
    expect(computeMFI(flat, 2)).toEqual([{ time: 3, value: 50 }]);
  });
  it('範圍 [0,100] 且邊界回空', () => {
    const bars = Array.from({ length: 40 }, (_, i) => HLC(i + 1, 12 + Math.sin(i) * 3, 8 + Math.sin(i) * 3, 10 + Math.sin(i) * 3, 100 + i));
    computeMFI(bars, 14).forEach((pt) => {
      expect(pt.value).toBeGreaterThanOrEqual(0);
      expect(pt.value).toBeLessThanOrEqual(100);
    });
    expect(computeMFI([B(1, 10, 1), B(2, 11, 1)], 2)).toEqual([]);
    expect(computeMFI([], 14)).toEqual([]);
  });
});

describe('computeROC', () => {
  it('golden：(C/Cn − 1)×100', () => {
    const bars = [10, 20, 40].map((c, i) => B(i + 1, c));
    expect(values(computeROC(bars, 1))).toEqual([100, 100]);
    expect(values(computeROC(bars, 2))).toEqual([300]);
  });
  it('邊界', () => {
    expect(computeROC([], 12)).toEqual([]);
    expect(computeROC([B(1, 10)], 12)).toEqual([]);
  });
});

describe('computeDMI / ADX', () => {
  it('單邊上升：+DI > 0、−DI = 0、ADX ∈ [0,100] 且遞增至高檔', () => {
    const bars = Array.from({ length: 10 }, (_, i) => HLC(i + 1, 10 + i, 5 + i, 8 + i));
    const { plusDI, minusDI, adx } = computeDMI(bars, 3, 3);
    expect(plusDI.length).toBe(7);   // index 3..9
    expect(adx.length).toBe(5);      // index 5..9
    plusDI.forEach((pt) => expect(pt.value).toBeGreaterThan(0));
    minusDI.forEach((pt) => expect(pt.value).toBe(0));
    adx.forEach((pt) => {
      expect(pt.value).toBeGreaterThanOrEqual(0);
      expect(pt.value).toBeLessThanOrEqual(100);
    });
    expect(adx[adx.length - 1].value).toBeGreaterThan(90);  // 純單邊 → DX=100 → ADX 收斂向 100
  });
  it('邊界：不足回空、單根不崩', () => {
    expect(computeDMI([], 14, 14).plusDI).toEqual([]);
    expect(computeDMI([HLC(1, 10, 5, 8)], 14, 14).adx).toEqual([]);
  });
});

describe('computeVolumeMA', () => {
  it('量柱逐根配色（紅漲綠跌）+ 量均 SMA', () => {
    const bars = [
      HLC(1, 11, 9, 11, 100, 10),  // close > open → 紅
      HLC(2, 11, 9, 9, 200, 10),   // close < open → 綠
      HLC(3, 11, 9, 10, 300, 10),
    ];
    const { volume, volMA } = computeVolumeMA(bars, 2);
    expect(values(volume)).toEqual([100, 200, 300]);
    expect(volume[0].color).toMatch(/239, 68, 68/);
    expect(volume[1].color).toMatch(/16, 185, 129/);
    expect(values(volMA)).toEqual([150, 250]);
    expect(times(volMA)).toEqual([2, 3]);
  });
  it('邊界：空回空；量均不足只出量柱', () => {
    expect(computeVolumeMA([], 5).volume).toEqual([]);
    const single = computeVolumeMA([B(1, 10, 42)], 5);
    expect(values(single.volume)).toEqual([42]);
    expect(single.volMA).toEqual([]);
  });
});
