/**
 * indicatorWorkerClient.ts — 主執行緒側的自訂指標 worker 管理（Sprint E）
 *
 * 職責：
 *   - 懶建立 module worker（Vite: new URL + type:'module'）
 *   - 每個請求掛 2 秒 timeout：逾時（多半是無窮迴圈）→ worker.terminate()
 *     砍掉整個執行緒（new Function 無法從外部中斷,只能砍執行緒）,
 *     以 {error} 收場,下次請求再重建 worker。
 *   - 一律 resolve（錯誤放 result.error）,呼叫端不需 try/catch。
 */
import type { Candle } from './indicators';
import type { CustomRunResult } from './customIndicator';

interface PendingReq {
  resolve: (r: CustomRunResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const INDICATOR_WORKER_TIMEOUT_MS = 2000;

export class IndicatorWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingReq>();
  private seq = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = INDICATOR_WORKER_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(
        new URL('../workers/indicatorWorker.ts', import.meta.url),
        { type: 'module' },
      );
      this.worker.onmessage = (ev: MessageEvent<{ reqId: number; result: CustomRunResult }>) => {
        const req = this.pending.get(ev.data.reqId);
        if (req) {
          clearTimeout(req.timer);
          this.pending.delete(ev.data.reqId);
          req.resolve(ev.data.result);
        }
      };
      this.worker.onerror = () => {
        // worker 層級錯誤（載入失敗等）→ 全部 pending 收錯誤,砍掉重建
        this.settleAll('自訂指標 worker 發生錯誤');
        this.terminate();
      };
    }
    return this.worker;
  }

  /** 執行自訂指標代碼；永遠 resolve（錯誤在 result.error） */
  run(code: string, candles: Candle[], params: Record<string, number>): Promise<CustomRunResult> {
    if (typeof Worker === 'undefined') {
      return Promise.resolve({ plots: [], hlines: [], error: '此環境不支援 Web Worker' });
    }
    const reqId = ++this.seq;
    return new Promise<CustomRunResult>((resolve) => {
      const timer = setTimeout(() => {
        // 逾時：先移除自己,再把其他 pending 一併收錯誤（同一 worker 都被砍）
        this.pending.delete(reqId);
        this.settleAll(`自訂指標執行逾時（>${this.timeoutMs}ms）,worker 已中止`);
        this.terminate();
        resolve({
          plots: [],
          hlines: [],
          error: `執行逾時（>${this.timeoutMs}ms）,已強制中止。請檢查是否有無窮迴圈。`,
        });
      }, this.timeoutMs);
      this.pending.set(reqId, { resolve, timer });
      try {
        this.ensureWorker().postMessage({ reqId, code, candles, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(reqId);
        resolve({ plots: [], hlines: [], error: '無法啟動自訂指標 worker' });
      }
    });
  }

  private settleAll(message: string): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.resolve({ plots: [], hlines: [], error: message });
    }
    this.pending.clear();
  }

  /** 砍掉 worker（無窮迴圈唯一解）；下次 run 會重建 */
  terminate(): void {
    try {
      this.worker?.terminate();
    } catch {
      // 已死透 → 忽略
    }
    this.worker = null;
  }

  dispose(): void {
    this.settleAll('worker 已釋放');
    this.terminate();
  }
}
