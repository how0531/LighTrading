import { describe, it, expect } from 'vitest';
import { nearestLadderPrice, resolveAnchorTarget } from './domAnchor';

// fullPrices 為降序（DOMPanel 上方高價、下方低價）
const ladder = [17010, 17009, 17008, 17007, 17006, 17005];

describe('nearestLadderPrice', () => {
  it('精準命中', () => {
    expect(nearestLadderPrice(17007, ladder)).toBe(17007);
  });
  it('取最接近（股票成本落在 tick 之間）', () => {
    expect(nearestLadderPrice(17007.4, ladder)).toBe(17007);
    expect(nearestLadderPrice(17007.6, ladder)).toBe(17008);
  });
  it('並列時取較大值（偏上方）', () => {
    expect(nearestLadderPrice(17007.5, ladder)).toBe(17008);
  });
  it('超出範圍 → 夾到邊界', () => {
    expect(nearestLadderPrice(99999, ladder)).toBe(17010);
    expect(nearestLadderPrice(1, ladder)).toBe(17005);
  });
  it('空 ladder / 非法 target → null', () => {
    expect(nearestLadderPrice(17007, [])).toBeNull();
    expect(nearestLadderPrice(0, ladder)).toBeNull();
    expect(nearestLadderPrice(-5, ladder)).toBeNull();
  });
});

describe('resolveAnchorTarget', () => {
  it('price 模式回現價', () => {
    expect(resolveAnchorTarget('price', 17008, 17000)).toBe(17008);
  });
  it('cost 模式且有成本 → 回成本', () => {
    expect(resolveAnchorTarget('cost', 17008, 17000)).toBe(17000);
  });
  it('cost 模式但無成本（0）→ 退回現價', () => {
    expect(resolveAnchorTarget('cost', 17008, 0)).toBe(17008);
  });
});
