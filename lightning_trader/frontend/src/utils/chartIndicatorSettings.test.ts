/**
 * chartIndicatorSettings — 自訂指標持久化上限（P2）
 *
 * normalize 時強制 code 長度上限與自訂指標數量上限,避免超大字串/無限累積
 * 灌爆 localStorage 與後端同步配額。
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeChartIndicatorSettings,
  MAX_CUSTOM_CODE_LEN,
  MAX_CUSTOM_INDICATORS,
} from './chartIndicatorSettings';

const mkCustom = (i: number, code: string) => ({
  id: `custom_${i}`,
  name: `ind${i}`,
  code,
  params: [],
  lines: [],
});

describe('normalizeChartIndicatorSettings — 自訂指標上限', () => {
  it('code 超過長度上限 → 丟棄該自訂指標', () => {
    const ok = mkCustom(1, 'plot("a", close);');
    const tooBig = mkCustom(2, 'x'.repeat(MAX_CUSTOM_CODE_LEN + 1));
    const res = normalizeChartIndicatorSettings({ active: [], favorites: [], custom: [ok, tooBig] });
    expect(res.custom.map((c) => c.id)).toEqual(['custom_1']);
  });

  it('恰好等於上限 → 保留', () => {
    const atLimit = mkCustom(1, 'a'.repeat(MAX_CUSTOM_CODE_LEN));
    const res = normalizeChartIndicatorSettings({ active: [], favorites: [], custom: [atLimit] });
    expect(res.custom.length).toBe(1);
  });

  it('自訂指標數量超過上限 → 只保留前 N 個', () => {
    const many = Array.from({ length: MAX_CUSTOM_INDICATORS + 5 }, (_, i) =>
      mkCustom(i, 'plot("a", close);'));
    const res = normalizeChartIndicatorSettings({ active: [], favorites: [], custom: many });
    expect(res.custom.length).toBe(MAX_CUSTOM_INDICATORS);
  });
});
