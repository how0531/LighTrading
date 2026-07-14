/**
 * settings.chart（指標系統）持久化 round-trip 測試（Sprint E）
 *
 * 覆蓋：
 *  1. localStorage 預載 → SettingsProvider 初始化 merge（normalize）
 *  2. updateSetting（picker 寫入路徑）→ localStorage 寫回 → 再次載入一致
 *  3. 壞資料清洗：未知 indicatorId 丟棄、參數 clamp、樣式非法欄位剔除
 *  4. 舊版設定（無 chart key）→ 預設 SMA20 + VOL
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { useEffect } from 'react';
import { render, act } from '@testing-library/react';
import { SettingsProvider, useSettings } from './SettingsContext';
import type { Settings } from './SettingsContext';
import {
  defaultChartIndicatorSettings,
  normalizeChartIndicatorSettings,
  createActiveIndicator,
  resolveIndicatorInfo,
  type ChartIndicatorSettings,
} from '../utils/chartIndicatorSettings';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(() => Promise.resolve({ data: {} })),
      post: vi.fn(() => Promise.resolve({ data: {} })),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    },
  };
});

const STORAGE_KEY = 'lightrade_settings';

interface CapturedApi {
  settings: Settings;
  updateSetting: (updates: Partial<Settings> | ((prev: Settings) => Settings)) => void;
}

const Capture: React.FC<{ apiRef: { current: CapturedApi | null } }> = ({ apiRef }) => {
  const api = useSettings();
  useEffect(() => {
    apiRef.current = api;
  });
  return null;
};

function renderProvider() {
  const apiRef: { current: CapturedApi | null } = { current: null };
  render(
    <SettingsProvider>
      <Capture apiRef={apiRef} />
    </SettingsProvider>,
  );
  return apiRef as { current: CapturedApi };
}

describe('settings.chart round-trip', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('無存檔 → 預設啟用 SMA20 + VOL', () => {
    const api = renderProvider();
    const chart = api.current.settings.chart;
    expect(chart.active.map((a) => a.indicatorId)).toEqual(['sma', 'vol']);
    expect(chart.active[0].params).toEqual({ period: 20 });
    expect(chart.favorites).toEqual([]);
    expect(chart.custom).toEqual([]);
  });

  it('localStorage 預載（含自訂指標 + 樣式覆寫）→ 完整還原', () => {
    const stored: ChartIndicatorSettings = {
      active: [
        {
          instanceId: 'i1',
          indicatorId: 'macd',
          visible: false,
          params: { fast: 10, slow: 30, signal: 7 },
          styles: { dif: { color: '#123456', lineWidth: 2, lineStyle: 'dashed' } },
        },
        {
          instanceId: 'i2',
          indicatorId: 'custom_abc',
          visible: true,
          params: { period: 7 },
          styles: {},
        },
      ],
      favorites: ['macd', 'custom_abc'],
      custom: [{
        id: 'custom_abc',
        name: '我的指標',
        code: "plot('x', close)",
        params: [{ key: 'period', label: '週期', default: 5, min: 1, max: 100 }],
        lines: [{ name: 'x', style: 'line', pane: 'sub' }],
      }],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chart: stored }));

    const api = renderProvider();
    const chart = api.current.settings.chart;
    expect(chart.active.length).toBe(2);
    expect(chart.active[0]).toEqual(stored.active[0]);
    expect(chart.active[1].indicatorId).toBe('custom_abc');
    expect(chart.active[1].params).toEqual({ period: 7 });
    expect(chart.favorites).toEqual(['macd', 'custom_abc']);
    expect(chart.custom[0].name).toBe('我的指標');
    expect(chart.custom[0].code).toBe("plot('x', close)");
  });

  it('updateSetting（picker 寫入）→ localStorage 寫回,重載一致', () => {
    // F5：localStorage 寫入改為 debounce（~300ms），用 fake timers 推進計時器讓它落盤
    vi.useFakeTimers();
    try {
      const api = renderProvider();
      act(() => {
        api.current.updateSetting((prev) => {
          const cfg = createActiveIndicator('supertrend', prev.chart.custom)!;
          return {
            ...prev,
            chart: {
              ...prev.chart,
              active: [...prev.chart.active, { ...cfg, instanceId: 'st1' }],
              favorites: ['supertrend'],
            },
          };
        });
      });

      expect(api.current.settings.chart.active.map((a) => a.indicatorId))
        .toEqual(['sma', 'vol', 'supertrend']);
      expect(api.current.settings.chart.active[2].params).toEqual({ period: 10, mult: 3 });

      // debounce flush → localStorage 落盤
      act(() => { vi.advanceTimersByTime(300); });

      const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(persisted.chart.active.map((a: { indicatorId: string }) => a.indicatorId))
        .toEqual(['sma', 'vol', 'supertrend']);
      expect(persisted.chart.favorites).toEqual(['supertrend']);

      // round-trip：以寫回的 JSON 再 normalize → 不變
      expect(normalizeChartIndicatorSettings(persisted.chart)).toEqual(api.current.settings.chart);
    } finally {
      vi.useRealTimers();
    }
  });

  it('壞資料清洗：未知指標丟棄、參數 clamp、非法樣式剔除、收藏過濾', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      chart: {
        active: [
          { instanceId: 'a', indicatorId: 'sma', visible: true, params: { period: 99999, hack: 1 }, styles: { sma: { color: '#fff', lineWidth: 9, lineStyle: 'zigzag' } } },
          { instanceId: 'b', indicatorId: 'not_exist', visible: true, params: {}, styles: {} },
          { instanceId: 'c', indicatorId: 'custom_gone', visible: true, params: {}, styles: {} },
          'garbage',
        ],
        favorites: ['sma', 'not_exist', 'sma'],
        custom: [{ id: 'bad-prefix', name: 'x', code: 'plot()' }],
      },
    }));

    const api = renderProvider();
    const chart = api.current.settings.chart;
    expect(chart.active.length).toBe(1);
    expect(chart.active[0].indicatorId).toBe('sma');
    expect(chart.active[0].params).toEqual({ period: 500 });        // clamp 到 max
    expect(chart.active[0].styles.sma).toEqual({ color: '#fff' }); // 非法 width/style 剔除
    expect(chart.favorites).toEqual(['sma']);                       // 未知/重複過濾
    expect(chart.custom).toEqual([]);                               // id 前綴不合法
  });

  it('舊版設定（無 chart）→ 預設值;空 active 陣列則尊重使用者清空', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'dark' }));
    const api = renderProvider();
    expect(api.current.settings.chart).toEqual(defaultChartIndicatorSettings());
  });

  it('active: [] 持久化後不會被預設覆蓋（使用者移除全部指標）', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      chart: { active: [], favorites: [], custom: [] },
    }));
    const api = renderProvider();
    expect(api.current.settings.chart.active).toEqual([]);
  });
});

describe('chartIndicatorSettings 純函式', () => {
  it('createActiveIndicator：內建/自訂/未知', () => {
    const sma = createActiveIndicator('sma', []);
    expect(sma?.params).toEqual({ period: 20 });
    expect(sma?.visible).toBe(true);
    const customDefs = [{
      id: 'custom_z', name: 'Z', code: '', params: [{ key: 'n', label: 'N', default: 3, min: 1, max: 10 }], lines: [],
    }];
    expect(createActiveIndicator('custom_z', customDefs)?.params).toEqual({ n: 3 });
    expect(createActiveIndicator('nope', [])).toBeNull();
  });

  it('createActiveIndicator：instanceId 唯一', () => {
    const a = createActiveIndicator('sma', [])!;
    const b = createActiveIndicator('sma', [])!;
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it('resolveIndicatorInfo：內建含 meta、自訂含 def', () => {
    expect(resolveIndicatorInfo('kd', [])?.kind).toBe('builtin');
    expect(resolveIndicatorInfo('kd', [])?.builtinMeta?.lines.length).toBe(2);
    const defs = [{ id: 'custom_q', name: 'Q', code: '', params: [], lines: [] }];
    expect(resolveIndicatorInfo('custom_q', defs)?.kind).toBe('custom');
    expect(resolveIndicatorInfo('missing', defs)).toBeNull();
  });

  it('normalize 冪等：normalize(normalize(x)) === normalize(x)', () => {
    const messy = {
      active: [
        { instanceId: 'a', indicatorId: 'kd', visible: false, params: { period: 5 }, styles: { k: { color: '#abc123' } } },
      ],
      favorites: ['kd'],
      custom: [],
    };
    const once = normalizeChartIndicatorSettings(messy);
    expect(normalizeChartIndicatorSettings(once)).toEqual(once);
  });
});
