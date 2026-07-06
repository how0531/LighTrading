/**
 * IndicatorWorkerClient — 逾時歸咎 + 無辜請求重新派送（P1）
 *
 * jsdom 無真正 Worker,故以注入的 FakeWorker 驗證佇列/逾時語意：
 *   - 逾時只 reject「正在執行的那一筆」（culprit）,不誤殺同批其他請求,
 *   - 佇列中尚未送出的請求在 terminate 後於重建的 worker 上重跑。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IndicatorWorkerClient, type WorkerLike } from './indicatorWorkerClient';
import type { Candle } from './indicators';
import type { CustomRunResult } from './customIndicator';

const BARS: Candle[] = [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
const OK_RESULT: CustomRunResult = {
  plots: [{ name: 'p', points: [], style: 'line', pane: 'sub' }],
  hlines: [],
};

/** 模擬 worker：code==='LOOP' 永不回應（→ 觸發逾時）；否則微任務回應 OK。 */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  posted: Array<{ reqId: number; code: string }> = [];
  terminated = false;
  static instances: FakeWorker[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: unknown): void {
    const m = msg as { reqId: number; code: string };
    this.posted.push(m);
    if (m.code !== 'LOOP' && !this.terminated) {
      queueMicrotask(() => {
        if (this.terminated) return;
        this.onmessage?.({ data: { reqId: m.reqId, result: OK_RESULT } } as unknown as MessageEvent);
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const factory = () => new FakeWorker();

beforeEach(() => {
  FakeWorker.instances = [];
});

describe('IndicatorWorkerClient — 逾時歸咎與重新派送', () => {
  it('逾時只殺當事那筆,佇列中無辜請求於重建 worker 重跑並成功', async () => {
    const client = new IndicatorWorkerClient(30, factory);
    const pLoop = client.run('LOOP', BARS, {});
    const pInnocent = client.run('OK', BARS, {});

    const [rLoop, rInnocent] = await Promise.all([pLoop, pInnocent]);
    expect(rLoop.error).toMatch(/逾時/);
    expect(rInnocent.error).toBeUndefined();
    expect(rInnocent.plots.length).toBe(1);

    // 原 worker 被 terminate、重建了第二個 worker 跑無辜請求
    expect(FakeWorker.instances.length).toBe(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances[1].posted.map((p) => p.code)).toEqual(['OK']);
  });

  it('正常序列：多筆請求重用同一 worker,皆成功', async () => {
    const client = new IndicatorWorkerClient(1000, factory);
    const r1 = await client.run('A', BARS, {});
    const r2 = await client.run('B', BARS, {});
    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(FakeWorker.instances.length).toBe(1); // 未逾時 → 不重建
  });

  it('worker onerror（系統性）→ 當事 + 佇列全部收錯', async () => {
    const client = new IndicatorWorkerClient(1000, factory);
    const p1 = client.run('LOOP', BARS, {});
    const p2 = client.run('X', BARS, {});
    // run() 同步 pump：p1 已在途、p2 在佇列
    FakeWorker.instances[0].onerror?.({});
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.error).toContain('worker');
    expect(b.error).toContain('worker');
  });

  it('dispose 收掉所有未決請求', async () => {
    const client = new IndicatorWorkerClient(1000, factory);
    const p = client.run('LOOP', BARS, {});
    client.dispose();
    const r = await p;
    expect(r.error).toContain('釋放');
  });

  it('無 Worker 環境（未注入 factory）→ 回不支援', async () => {
    const client = new IndicatorWorkerClient();
    const r = await client.run('x', BARS, {});
    expect(r.error).toContain('不支援');
  });
});
