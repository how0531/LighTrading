/** IndicatorPicker 純函式測試（Sprint E） */
import { describe, it, expect } from 'vitest';
import { fuzzyMatch, toHexColor } from './indicatorPickerUtils';

describe('fuzzyMatch（中文名/id 模糊搜尋）', () => {
  it('空查詢全命中', () => {
    expect(fuzzyMatch('', '布林通道 BBands')).toBe(true);
    expect(fuzzyMatch('   ', 'x')).toBe(true);
  });

  it('子字串命中（大小寫不敏感）', () => {
    expect(fuzzyMatch('布林', '布林通道 BBands bbands')).toBe(true);
    expect(fuzzyMatch('BBANDS', '布林通道 BBands bbands')).toBe(true);
    expect(fuzzyMatch('macd', 'MACD 指數平滑異同 macd')).toBe(true);
  });

  it('字元依序出現（模糊）命中', () => {
    expect(fuzzyMatch('bnd', 'bbands')).toBe(true);   // b..n..d
    expect(fuzzyMatch('超趨', '超級趨勢 SuperTrend')).toBe(true);
  });

  it('順序不符 → 不命中', () => {
    expect(fuzzyMatch('dnb', 'bbands')).toBe(false);
    expect(fuzzyMatch('rsi', 'macd')).toBe(false);
  });
});

describe('toHexColor（color input 需要 #rrggbb）', () => {
  it('#rrggbb 原樣、#rgb 展開', () => {
    expect(toHexColor('#60a5fa')).toBe('#60a5fa');
    expect(toHexColor('#abc')).toBe('#aabbcc');
  });

  it('rgba()/rgb() 轉換', () => {
    expect(toHexColor('rgba(34, 211, 238, 0.55)')).toBe('#22d3ee');
    expect(toHexColor('rgb(239,68,68)')).toBe('#ef4444');
  });

  it('解析失敗回灰', () => {
    expect(toHexColor('gold')).toBe('#94a3b8');
  });
});
