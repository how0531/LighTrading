/**
 * 自訂 JS 指標 harness 測試（Sprint E）
 *
 * runUserIndicator 為純函式（worker 只是 postMessage 殼）——
 * 這裡直接測：plot 蒐集/自動偵測、ta 注入、錯誤傳遞（含行號 hint）、
 * 作用域遮蔽（sandbox defense-in-depth）、參數註解解析。
 */
import { describe, it, expect } from 'vitest';
import {
  runUserIndicator,
  parseParamComments,
  makeTa,
  syntheticCandles,
} from './customIndicator';
import { alignedSMA, type Candle } from './indicators';

const B = (t: number, c: number, v = 10): Candle => ({
  time: t, open: c, high: c + 1, low: c - 1, close: c, volume: v,
});
const BARS = [10, 12, 14, 16, 18].map((c, i) => B(i + 1, c));

describe('runUserIndicator — plot 蒐集與自動偵測', () => {
  it('aligned 數值陣列：NaN 暖身自動略過、index 對映 K 棒 time', () => {
    const res = runUserIndicator('plot("ma", ta.sma(close, 2));', BARS, {});
    expect(res.error).toBeUndefined();
    expect(res.plots.length).toBe(1);
    expect(res.plots[0].name).toBe('ma');
    expect(res.plots[0].points).toEqual([
      { time: 2, value: 11 },
      { time: 3, value: 13 },
      { time: 4, value: 15 },
      { time: 5, value: 17 },
    ]);
  });

  it('多條 plot 依呼叫順序蒐集；style/pane/color 選項', () => {
    const res = runUserIndicator(`
      plot('a', close, { pane: 'main', color: '#ff0000' });
      plot('b', volume, { style: 'histogram' });
      plot('c', close);
    `, BARS, {});
    expect(res.plots.map((p) => p.name)).toEqual(['a', 'b', 'c']);
    expect(res.plots[0].pane).toBe('main');
    expect(res.plots[0].color).toBe('#ff0000');
    expect(res.plots[0].style).toBe('line');
    expect(res.plots[1].style).toBe('histogram');
    expect(res.plots[1].pane).toBe('sub');      // 預設副圖
    expect(res.plots[2].color).toBeUndefined(); // 未指定 → 掛圖時給預設
  });

  it('{time, value} 物件陣列模式', () => {
    const res = runUserIndicator(
      'plot("pts", [{ time: 100, value: 1 }, { time: 200, value: 2 }, null]);',
      BARS, {},
    );
    expect(res.plots[0].points).toEqual([
      { time: 100, value: 1 },
      { time: 200, value: 2 },
    ]);
  });

  it('重名 plot 自動加尾碼', () => {
    const res = runUserIndicator('plot("x", close); plot("x", volume);', BARS, {});
    expect(res.plots.map((p) => p.name)).toEqual(['x', 'x_2']);
  });

  it('hline 蒐集', () => {
    const res = runUserIndicator('hline(30, { color: "#888" }); hline(70);', BARS, {});
    expect(res.hlines).toEqual([{ value: 30, color: '#888' }, { value: 70 }]);
  });

  it('params 注入', () => {
    const res = runUserIndicator(
      'plot("scaled", close.map(c => c * params.mult));',
      BARS, { mult: 2 },
    );
    expect(res.plots[0].points[0]).toEqual({ time: 1, value: 20 });
  });

  it('candles / open / high / low / time 皆可用', () => {
    const res = runUserIndicator(`
      plot('spread', high.map((h, i) => h - low[i]));
      plot('first', [candles[0].close]);
      plot('t', time.map(t => t * 0));
    `, BARS, {});
    expect(res.plots[0].points.every((p) => p.value === 2)).toBe(true);
    expect(res.plots[1].points).toEqual([{ time: 1, value: 10 }]);
    expect(res.plots[2].points.length).toBe(BARS.length);
  });

  it('ta.crossover / ta.atr 等工具可用', () => {
    const res = runUserIndicator(`
      const fast = ta.sma(close, 1);
      const slow = ta.sma(close, 3);
      const x = ta.crossover(fast, slow);
      plot('sig', x.map(b => b ? 1 : 0));
      plot('atr', ta.atr(2));
    `, BARS, {});
    expect(res.error).toBeUndefined();
    expect(res.plots[0].points.length).toBe(BARS.length);
    expect(res.plots[1].points.length).toBeGreaterThan(0);
  });
});

describe('runUserIndicator — 錯誤傳遞', () => {
  it('throw → {error},不外拋', () => {
    const res = runUserIndicator('throw new Error("自爆")', BARS, {});
    expect(res.plots).toEqual([]);
    expect(res.error).toContain('自爆');
  });

  it('錯誤行號 hint（使用者代碼 1-based）', () => {
    const code = 'const a = 1;\nconst b = 2;\nthrow new Error("第三行");';
    const res = runUserIndicator(code, BARS, {});
    expect(res.error).toContain('第三行');
    // stack 格式依引擎而異,拿得到就必須正確
    if (res.errorLine !== undefined) expect(res.errorLine).toBe(3);
  });

  it('語法錯誤 → error（new Function 建構期）', () => {
    const res = runUserIndicator('const = broken(', BARS, {});
    expect(res.error).toBeTruthy();
    expect(res.error).toMatch(/SyntaxError/);
  });

  it('plot 參數驗證：name 非字串 / values 非陣列 / 長度超過 K 棒', () => {
    expect(runUserIndicator('plot(42, close)', BARS, {}).error).toContain('name');
    expect(runUserIndicator('plot("x", "oops")', BARS, {}).error).toContain('陣列');
    expect(
      runUserIndicator('plot("x", new Array(999).fill(1))', BARS, {}).error,
    ).toContain('999');
  });

  it('hline 參數驗證', () => {
    expect(runUserIndicator('hline("nope")', BARS, {}).error).toContain('hline');
  });

  it('runtime ReferenceError（未定義變數）→ error', () => {
    const res = runUserIndicator('plot("x", notExist)', BARS, {});
    expect(res.error).toMatch(/ReferenceError/);
  });
});

describe('runUserIndicator — 沙箱遮蔽（defense-in-depth）', () => {
  it.each([
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
    'indexedDB', 'localStorage', 'sessionStorage', 'caches',
    'globalThis', 'self', 'window', 'document', 'navigator', 'postMessage',
  ])('使用者代碼內 typeof %s === "undefined"', (name) => {
    const res = runUserIndicator(
      `plot('probe', close.map(() => typeof ${name} === 'undefined' ? 1 : 0));`,
      BARS, {},
    );
    expect(res.error).toBeUndefined();
    expect(res.plots[0].points.every((p) => p.value === 1)).toBe(true);
  });

  it('嚴格模式：未宣告賦值 → 錯誤（不污染全域）', () => {
    const res = runUserIndicator('leaked = 123; plot("x", close);', BARS, {});
    expect(res.error).toMatch(/ReferenceError/);
  });
});

describe('parseParamComments', () => {
  it('完整格式：key 預設 最小 最大 標籤', () => {
    expect(parseParamComments('//@param period 14 1 200 週期')).toEqual([
      { key: 'period', label: '週期', default: 14, min: 1, max: 200 },
    ]);
  });

  it('省略範圍 → 寬鬆界線；省略標籤 → key', () => {
    const [prm] = parseParamComments('// @param mult 2.5');
    expect(prm.key).toBe('mult');
    expect(prm.label).toBe('mult');
    expect(prm.default).toBe(2.5);
    expect(prm.min).toBe(-1_000_000);
    expect(prm.max).toBe(1_000_000);
  });

  it('多參數、重複 key 取第一次、非 @param 行忽略', () => {
    const code = [
      '//@param fast 5 1 120 快線',
      'const x = 1; // @param 不是宣告',
      '//@param slow 20 1 240 慢線',
      '//@param fast 99 1 10 重複忽略',
      '// 普通註解',
    ].join('\n');
    const prms = parseParamComments(code);
    expect(prms.map((p) => p.key)).toEqual(['fast', 'slow']);
    expect(prms[0].default).toBe(5);
  });

  it('預設值超界 → clamp 進 [min, max]；min > max 自動交換', () => {
    expect(parseParamComments('//@param p 999 1 100')[0].default).toBe(100);
    const [prm] = parseParamComments('//@param q 5 100 1');
    expect(prm.min).toBe(1);
    expect(prm.max).toBe(100);
  });

  it('非法行不解析', () => {
    expect(parseParamComments('//@param 3abc 14')).toEqual([]);
    expect(parseParamComments('//@param noDefault')).toEqual([]);
  });
});

describe('makeTa / syntheticCandles', () => {
  it('ta.sma 委派 alignedSMA', () => {
    const ta = makeTa(BARS);
    expect(ta.sma([1, 2, 3], 2)).toEqual(alignedSMA([1, 2, 3], 2));
  });

  it('ta.atr / ta.tr 綁定 candles', () => {
    const ta = makeTa(BARS);
    expect(ta.tr().length).toBe(BARS.length);
    expect(ta.atr(2).filter(Number.isFinite).length).toBe(BARS.length - 1);
  });

  it('syntheticCandles：可餵驗證的合法 K 棒', () => {
    const c = syntheticCandles(50);
    expect(c.length).toBe(50);
    for (const bar of c) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.volume).toBeGreaterThan(0);
    }
    // 時間遞增
    for (let i = 1; i < c.length; i++) expect(c[i].time).toBeGreaterThan(c[i - 1].time);
  });

  it('編輯器範本情境：雙均線 + 乖離 + hline 全流程', () => {
    const code = [
      '//@param fast 2 1 120 快線週期',
      '//@param slow 3 1 240 慢線週期',
      "const fastMa = ta.sma(close, params.fast);",
      "const slowMa = ta.sma(close, params.slow);",
      "plot('快線', fastMa, { color: '#60a5fa', pane: 'main' });",
      "plot('慢線', slowMa, { color: '#fb923c', pane: 'main' });",
      "plot('乖離', fastMa.map((v, i) => v - slowMa[i]), { style: 'histogram' });",
      'hline(0);',
    ].join('\n');
    const params = Object.fromEntries(parseParamComments(code).map((p) => [p.key, p.default]));
    const res = runUserIndicator(code, syntheticCandles(60), params);
    expect(res.error).toBeUndefined();
    expect(res.plots.map((p) => p.name)).toEqual(['快線', '慢線', '乖離']);
    expect(res.plots[0].pane).toBe('main');
    expect(res.plots[2].style).toBe('histogram');
    expect(res.hlines).toEqual([{ value: 0 }]);
  });
});
