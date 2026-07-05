/**
 * indicatorRegistry 完整性測試（Sprint E）
 *
 * 21 種指標都要有 metadata / 參數 schema / 輸出線定義,
 * 且 compute 輸出與線定義的 key 一一對應、時間遞增、值有限。
 */
import { describe, it, expect } from 'vitest';
import {
  INDICATOR_REGISTRY,
  getIndicatorMeta,
  defaultParamsOf,
  sanitizeParams,
  safeCompute,
  type IndicatorMeta,
} from './indicatorRegistry';
import type { Candle } from './indicators';

function synthBars(n: number): Candle[] {
  const out: Candle[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = 100 + Math.sin(i / 5) * 10 + Math.cos(i / 13) * 5;
    out.push({
      time: 1_700_000_000 + i * 60,
      open,
      high: Math.max(open, close) + 2,
      low: Math.min(open, close) - 2,
      close,
      volume: 50 + (i % 7) * 30,
    });
  }
  return out;
}

describe('registry 完整性', () => {
  it('共 21 種：主圖 10 + 副圖 11', () => {
    expect(INDICATOR_REGISTRY.length).toBe(21);
    expect(INDICATOR_REGISTRY.filter((m) => m.category === 'overlay').length).toBe(10);
    expect(INDICATOR_REGISTRY.filter((m) => m.category === 'pane').length).toBe(11);
  });

  it('規格要求的指標 id 全數存在', () => {
    const ids = new Set(INDICATOR_REGISTRY.map((m) => m.id));
    const required = [
      // 主圖
      'sma', 'ema', 'wma', 'bbands', 'donchian', 'keltner', 'psar', 'supertrend', 'vwap', 'envelope',
      // 副圖
      'macd', 'rsi', 'kd', 'atr', 'cci', 'obv', 'willr', 'mfi', 'roc', 'dmi', 'vol',
    ];
    for (const id of required) expect(ids.has(id), `缺少指標 ${id}`).toBe(true);
  });

  it('id 唯一、中文名 / short 非空', () => {
    const ids = INDICATOR_REGISTRY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of INDICATOR_REGISTRY) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.name).toMatch(/[一-鿿]/);  // 含中文
      expect(m.short.length).toBeGreaterThan(0);
    }
  });

  it('參數 schema：key 唯一、預設值落在 [min, max]、min < max', () => {
    for (const m of INDICATOR_REGISTRY) {
      const keys = m.params.map((p) => p.key);
      expect(new Set(keys).size, m.id).toBe(keys.length);
      for (const prm of m.params) {
        expect(prm.label.length, `${m.id}.${prm.key}`).toBeGreaterThan(0);
        expect(prm.min, `${m.id}.${prm.key}`).toBeLessThan(prm.max);
        expect(prm.default, `${m.id}.${prm.key}`).toBeGreaterThanOrEqual(prm.min);
        expect(prm.default, `${m.id}.${prm.key}`).toBeLessThanOrEqual(prm.max);
      }
    }
  });

  it('輸出線定義：至少一條、key 唯一、有預設色與線型', () => {
    for (const m of INDICATOR_REGISTRY) {
      expect(m.lines.length, m.id).toBeGreaterThan(0);
      const keys = m.lines.map((l) => l.key);
      expect(new Set(keys).size, m.id).toBe(keys.length);
      for (const line of m.lines) {
        expect(line.label.length, `${m.id}.${line.key}`).toBeGreaterThan(0);
        expect(line.color.length, `${m.id}.${line.key}`).toBeGreaterThan(0);
        expect(['line', 'histogram']).toContain(line.style);
      }
    }
  });

  it('compute（80 根合成資料）：輸出 key 與線定義一致、時間遞增、值有限', () => {
    const bars = synthBars(80);
    for (const m of INDICATOR_REGISTRY) {
      const results = m.compute(bars, defaultParamsOf(m.params));
      const resultKeys = results.map((r) => r.key).sort();
      const defKeys = m.lines.map((l) => l.key).sort();
      expect(resultKeys, m.id).toEqual(defKeys);
      for (const r of results) {
        expect(r.points.length, `${m.id}.${r.key} 應有資料`).toBeGreaterThan(0);
        let prev = -Infinity;
        for (const pt of r.points) {
          expect(Number.isFinite(pt.value), `${m.id}.${r.key} 值有限`).toBe(true);
          expect(pt.time, `${m.id}.${r.key} 時間遞增`).toBeGreaterThan(prev);
          prev = pt.time;
        }
        // 暖身期略過：點的起始時間 >= 第一根 bar
        expect(r.points[0].time).toBeGreaterThanOrEqual(bars[0].time);
      }
    }
  });

  it('compute 空資料 → 各線回空,不崩', () => {
    for (const m of INDICATOR_REGISTRY) {
      const results = m.compute([], defaultParamsOf(m.params));
      for (const r of results) expect(r.points, `${m.id}.${r.key}`).toEqual([]);
    }
  });

  it('compute 單根 → 不崩（允許 0 或 1 點）', () => {
    const one = synthBars(1);
    for (const m of INDICATOR_REGISTRY) {
      const results = m.compute(one, defaultParamsOf(m.params));
      for (const r of results) {
        expect(r.points.length, `${m.id}.${r.key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('getIndicatorMeta：存在/不存在', () => {
    expect(getIndicatorMeta('sma')?.name).toContain('SMA');
    expect(getIndicatorMeta('nope')).toBeUndefined();
  });
});

describe('參數工具', () => {
  it('defaultParamsOf：schema → 預設物件', () => {
    const meta = getIndicatorMeta('macd')!;
    expect(defaultParamsOf(meta.params)).toEqual({ fast: 12, slow: 26, signal: 9 });
  });

  it('sanitizeParams：clamp 範圍、未知 key 丟棄、缺漏補預設、非數字忽略', () => {
    const meta = getIndicatorMeta('sma')!;
    expect(sanitizeParams(meta.params, { period: 99999 })).toEqual({ period: 500 });
    expect(sanitizeParams(meta.params, { period: -5 })).toEqual({ period: 1 });
    expect(sanitizeParams(meta.params, { hack: 1 })).toEqual({ period: 20 });
    expect(sanitizeParams(meta.params, { period: 'x' })).toEqual({ period: 20 });
    expect(sanitizeParams(meta.params, null)).toEqual({ period: 20 });
  });

  it('safeCompute：compute throw → 各線回空,不外拋', () => {
    const bad: IndicatorMeta = {
      id: 'boom',
      name: '爆炸測試',
      short: 'BOOM',
      category: 'pane',
      params: [],
      lines: [{ key: 'x', label: 'X', color: '#fff', style: 'line' }],
      compute: () => { throw new Error('boom'); },
    };
    expect(safeCompute(bad, synthBars(10), {})).toEqual([{ key: 'x', points: [] }]);
  });

  it('safeCompute：正常路徑 = compute + sanitize', () => {
    const meta = getIndicatorMeta('sma')!;
    const bars = synthBars(30);
    const viaSafe = safeCompute(meta, bars, { period: 5 });
    const direct = meta.compute(bars, { period: 5 });
    expect(viaSafe).toEqual(direct);
  });
});
