/**
 * 自訂 JS 指標沙箱 — 逃逸向量測試（P0）
 *
 * 這裡驗證 poisonConstructorChain()（worker 載入時呼叫的那層）確實封死了
 * constructor chain 逃逸。poison 是對本 realm 不可逆、全域的操作,故獨立成一支
 * 測試檔——vitest forks 逐檔隔離（各檔獨立子行程），此檔的毒化不外溢到
 * customIndicator.test.ts 等其他檔（那些檔仍在未毒化的 realm 驗證遮蔽層）。
 *
 * 誠實聲明：這證明「已知的 constructor chain 取回全域」路徑被封,並非證明
 * 沙箱牢不可破。worker 端另有全域能力清空 + CSP 作為兜底（見 indicatorWorker.ts）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runUserIndicator, poisonConstructorChain } from './customIndicator';
import type { Candle } from './indicators';

const B = (t: number, c: number, v = 10): Candle => ({
  time: t, open: c, high: c + 1, low: c - 1, close: c, volume: v,
});
const BARS = [10, 12, 14, 16, 18].map((c, i) => B(i + 1, c));

beforeAll(() => {
  poisonConstructorChain();
});

/** 跑一段「嘗試取回全域」的表達式；回傳每根 K 棒是否「拿到了物件型全域」（1=逃逸） */
function escapedViaExpr(expr: string) {
  return runUserIndicator(
    `let g = null;
     try { g = (${expr}); } catch (e) { g = null; }
     plot('probe', close.map(() => (g && typeof g === 'object') ? 1 : 0));`,
    BARS, {},
  );
}

describe('沙箱：constructor chain 毒化封鎖逃逸', () => {
  it.each([
    ['(function(){}).constructor(\'return this\')()', 'Function via 一般函式'],
    ['[].constructor.constructor(\'return this\')()', 'Function via 陣列建構子鏈'],
    ['({}).constructor.constructor(\'return this\')()', 'Function via 物件建構子鏈'],
    ['(async function(){}).constructor(\'return this\')', 'AsyncFunction 建構子'],
    ['(function*(){}).constructor(\'return this\')', 'GeneratorFunction 建構子'],
    ['(async function*(){}).constructor(\'return this\')', 'AsyncGeneratorFunction 建構子'],
  ])('封鎖：%s（%s）', (expr) => {
    const res = escapedViaExpr(expr);
    expect(res.error).toBeUndefined();
    expect(res.plots[0].points.length).toBe(BARS.length);
    expect(res.plots[0].points.every((p) => p.value === 0)).toBe(true);
  });

  it('呼叫毒化後的 constructor 會 throw（不是靜默回 undefined）', () => {
    const res = runUserIndicator(
      `plot('p', close.map(() => {
         try { (function(){}).constructor('return 1'); return 1; }
         catch (e) { return 0; }
       }));`,
      BARS, {},
    );
    expect(res.error).toBeUndefined();
    expect(res.plots[0].points.every((p) => p.value === 0)).toBe(true);
  });

  it('裸名 Function / Worker / Blob / URL 仍被作用域遮蔽為 undefined', () => {
    const res = runUserIndicator(
      `plot('p', close.map(() =>
         (typeof Function === 'undefined'
          && typeof Worker === 'undefined'
          && typeof Blob === 'undefined'
          && typeof URL === 'undefined') ? 1 : 0));`,
      BARS, {},
    );
    expect(res.error).toBeUndefined();
    expect(res.plots[0].points.every((p) => p.value === 1)).toBe(true);
  });

  it('毒化後 harness 仍能正常建構/執行使用者指標（RealFunction 路徑不受影響）', () => {
    const res = runUserIndicator('plot("ma", ta.sma(close, 2));', BARS, {});
    expect(res.error).toBeUndefined();
    expect(res.plots[0].name).toBe('ma');
    expect(res.plots[0].points).toEqual([
      { time: 2, value: 11 }, { time: 3, value: 13 },
      { time: 4, value: 15 }, { time: 5, value: 17 },
    ]);
  });

  it('poisonConstructorChain 冪等（重複呼叫不 throw）', () => {
    expect(() => { poisonConstructorChain(); poisonConstructorChain(); }).not.toThrow();
  });
});
