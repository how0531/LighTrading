/**
 * indicatorWorkerClient.ts — 主執行緒側的自訂指標 worker 管理（Sprint E）
 *
 * 職責：
 *   - 懶建立 module worker（Vite: new URL + type:'module'）
 *   - 單一在途（single in-flight）序列化派送：worker 內是單執行緒、訊息本就
 *     依序處理,因此一次只送一筆、待回應或逾時才送下一筆。這讓「逾時」能
 *     精確歸咎於「正在執行的那一筆」（culprit）——而非同批其他無辜請求。
 *   - 逾時（多半是無窮迴圈）→ 只 reject 當事那筆,terminate() 砍掉執行緒
 *     （new Function 無法從外部中斷,只能砍執行緒）,其餘「仍在佇列、尚未送出」
 *     的請求原封不動,下一輪 pump 會在重建的 worker 上重新派送。
 *   - 一律 resolve（錯誤放 result.error）,呼叫端不需 try/catch。
 */
import type { Candle } from './indicators';
import type { CustomRunResult } from './customIndicator';

/** worker.terminate 之外只用到 postMessage 與兩個事件 handler，抽介面以利測試注入 */
export interface WorkerLike {
  postMessage: (msg: unknown) => void;
  terminate: () => void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

interface QueuedReq {
  reqId: number;
  code: string;
  candles: Candle[];
  params: Record<string, number>;
  resolve: (r: CustomRunResult) => void;
}

export const INDICATOR_WORKER_TIMEOUT_MS = 2000;

export class IndicatorWorkerClient {
  private worker: WorkerLike | null = null;
  /** 尚未送出的請求（FIFO）；逾時砍 worker 時這些無辜請求原封保留、重新派送 */
  private queue: QueuedReq[] = [];
  /** 已送出、正在 worker 內執行、等回應的那一筆（culprit 候選） */
  private inflight: QueuedReq | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private readonly timeoutMs: number;
  private readonly workerFactory: (() => WorkerLike) | null;

  constructor(timeoutMs: number = INDICATOR_WORKER_TIMEOUT_MS, workerFactory?: () => WorkerLike) {
    this.timeoutMs = timeoutMs;
    this.workerFactory = workerFactory ?? null;
  }

  /** 執行自訂指標代碼；永遠 resolve（錯誤在 result.error） */
  run(code: string, candles: Candle[], params: Record<string, number>): Promise<CustomRunResult> {
    if (!this.workerFactory && typeof Worker === 'undefined') {
      return Promise.resolve({ plots: [], hlines: [], error: '此環境不支援 Web Worker' });
    }
    const reqId = ++this.seq;
    return new Promise<CustomRunResult>((resolve) => {
      this.queue.push({ reqId, code, candles, params, resolve });
      this.pump();
    });
  }

  private createWorker(): WorkerLike {
    if (this.workerFactory) return this.workerFactory();
    return new Worker(
      new URL('../workers/indicatorWorker.ts', import.meta.url),
      { type: 'module' },
    ) as unknown as WorkerLike;
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (ev: MessageEvent<{ reqId: number; result: CustomRunResult }>) => {
      // 只認在途那筆的回應（reqId 對得上才收）
      if (!this.inflight || this.inflight.reqId !== ev.data.reqId) return;
      this.clearTimer();
      const done = this.inflight;
      this.inflight = null;
      done.resolve(ev.data.result);
      this.pump();
    };
    worker.onerror = () => {
      // worker 層級錯誤（載入失敗等,屬系統性）→ 當事 + 佇列全部收錯,砍掉重建
      this.clearTimer();
      const message = '自訂指標 worker 發生錯誤';
      const victims = this.inflight ? [this.inflight, ...this.queue] : [...this.queue];
      this.inflight = null;
      this.queue = [];
      this.terminate();
      for (const v of victims) v.resolve({ plots: [], hlines: [], error: message });
    };
    this.worker = worker;
    return worker;
  }

  /** 有空檔就送下一筆（維持單一在途） */
  private pump(): void {
    if (this.inflight || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.inflight = next;
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
      worker.postMessage({
        reqId: next.reqId, code: next.code, candles: next.candles, params: next.params,
      });
    } catch {
      this.inflight = null;
      next.resolve({ plots: [], hlines: [], error: '無法啟動自訂指標 worker' });
      this.pump();
      return;
    }
    this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
  }

  /** 逾時：只砍當事那筆,佇列中未送出的無辜請求重新派送到新 worker */
  private onTimeout(): void {
    this.timer = null;
    const culprit = this.inflight;
    this.inflight = null;
    // 砍掉卡住的執行緒（無窮迴圈唯一解）；下一輪 pump 會重建 worker
    this.terminate();
    if (culprit) {
      culprit.resolve({
        plots: [],
        hlines: [],
        error: `執行逾時（>${this.timeoutMs}ms）,已強制中止。請檢查是否有無窮迴圈。`,
      });
    }
    // 其餘 queue 原封不動 → 在重建的 worker 上重跑
    this.pump();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 砍掉 worker（無窮迴圈唯一解）；下次 pump 會重建 */
  terminate(): void {
    try {
      this.worker?.terminate();
    } catch {
      // 已死透 → 忽略
    }
    this.worker = null;
  }

  dispose(): void {
    this.clearTimer();
    const victims = this.inflight ? [this.inflight, ...this.queue] : [...this.queue];
    this.inflight = null;
    this.queue = [];
    this.terminate();
    for (const v of victims) v.resolve({ plots: [], hlines: [], error: 'worker 已釋放' });
  }
}
