import { describe, it, expect } from 'vitest';
import { LAYOUT_PRESETS, PRESET_ORDER, presetLabel } from './layoutPresets';

// 必須與 Dashboard 渲染的 grid items 完全一致，否則 react-grid-layout 會亂排
const PANEL_KEYS = ['watch', 'dom', 'chart', 'equity', 'stats', 'bal', 'pos', 'smart', 'journal', 'hist', 'trade'];

describe('LAYOUT_PRESETS', () => {
  for (const [id, preset] of Object.entries(LAYOUT_PRESETS)) {
    it(`${id} lg 含且僅含 11 個面板 key`, () => {
      const keys = preset.lg.map((g) => g.i).sort();
      expect(keys).toEqual([...PANEL_KEYS].sort());
    });
    it(`${id} lg 無重複 key`, () => {
      const keys = preset.lg.map((g) => g.i);
      expect(new Set(keys).size).toBe(keys.length);
    });
    it(`${id} 每格 x+w 不超出 12 欄`, () => {
      for (const g of preset.lg) {
        expect(g.x).toBeGreaterThanOrEqual(0);
        expect(g.x + g.w).toBeLessThanOrEqual(12);
        expect(g.w).toBeGreaterThan(0);
        expect(g.h).toBeGreaterThan(0);
      }
    });
  }

  it('momentum 預設 focus mode 開', () => {
    expect(LAYOUT_PRESETS.momentum.focusMode).toBe(true);
  });
  it('daytrade / swing 預設 focus mode 關', () => {
    expect(LAYOUT_PRESETS.daytrade.focusMode).toBe(false);
    expect(LAYOUT_PRESETS.swing.focusMode).toBe(false);
  });
});

describe('PRESET_ORDER / presetLabel', () => {
  it('順序含 custom 在最後', () => {
    expect(PRESET_ORDER).toEqual(['momentum', 'daytrade', 'swing', 'custom']);
  });
  it('custom label = 自訂', () => {
    expect(presetLabel('custom')).toBe('自訂');
  });
  it('preset label 對應', () => {
    expect(presetLabel('momentum')).toBe('動能');
    expect(presetLabel('daytrade')).toBe('當沖');
    expect(presetLabel('swing')).toBe('波段');
  });
});
