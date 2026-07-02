/**
 * priceColor 純函式測試 — 鎖定台灣紅漲綠跌慣例（架構整頓去重守門）
 */
import { describe, it, expect } from 'vitest';
import { priceColor, actionColor, UP_COLOR, DOWN_COLOR, FLAT_COLOR } from './priceColor';

describe('priceColor', () => {
  it('漲（>0）回紅', () => {
    expect(priceColor(1)).toBe(UP_COLOR);
    expect(priceColor(0.01)).toBe('text-red-400');
  });
  it('跌（<0）回綠', () => {
    expect(priceColor(-1)).toBe(DOWN_COLOR);
    expect(priceColor(-0.01)).toBe('text-emerald-400');
  });
  it('平盤（=0）回灰', () => {
    expect(priceColor(0)).toBe(FLAT_COLOR);
    expect(priceColor(0)).toBe('text-slate-400');
  });
});

describe('actionColor', () => {
  it('買=紅（大小寫不拘）', () => {
    expect(actionColor('Buy')).toBe(UP_COLOR);
    expect(actionColor('buy')).toBe(UP_COLOR);
  });
  it('賣=綠', () => {
    expect(actionColor('Sell')).toBe(DOWN_COLOR);
    expect(actionColor('sell')).toBe(DOWN_COLOR);
  });
  it('空字串視為賣方色（防禦性 fallback，不會 throw）', () => {
    expect(actionColor('')).toBe(DOWN_COLOR);
  });
});
