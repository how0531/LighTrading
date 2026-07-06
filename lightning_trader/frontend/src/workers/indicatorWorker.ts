/**
 * indicatorWorker.ts — 自訂 JS 指標的 Web Worker 沙箱（Sprint E）
 *
 * Vite module worker：new Worker(new URL('./indicatorWorker.ts', import.meta.url), { type: 'module' })
 * 可直接 import utils/customIndicator（其內委派 utils/indicators 的 ta 純函式）。
 *
 * 沙箱紀律（本檔負責的那層）：
 *   1. module 載入時（任何使用者代碼執行前）把 worker 全域的
 *      fetch / XMLHttpRequest / WebSocket / importScripts / indexedDB 等
 *      設成 undefined —— 使用者代碼在 worker 內拿不到網路與儲存能力。
 *   2. 使用者代碼 throw → runUserIndicator 內攔截，回傳 {error}。
 *   3. 無窮迴圈防護在主執行緒側（indicatorWorkerClient）：2 秒沒回應
 *      → worker.terminate() 整個砍掉重建。
 */
import { runUserIndicator, type CustomRunResult } from '../utils/customIndicator';
import type { Candle } from '../utils/indicators';

const g = self as unknown as Record<string, unknown>;

// 全域能力清空（先於任何 onmessage / 使用者代碼）
for (const key of [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
  'indexedDB', 'caches', 'navigator',
]) {
  try {
    Object.defineProperty(g, key, { value: undefined, configurable: false, writable: false });
  } catch {
    try {
      g[key] = undefined;
    } catch {
      // 唯讀且不可重定義 → 交給 harness 的作用域遮蔽層（customIndicator PRELUDE）
    }
  }
}

export interface IndicatorWorkerRequest {
  reqId: number;
  code: string;
  candles: Candle[];
  params: Record<string, number>;
}

export interface IndicatorWorkerResponse {
  reqId: number;
  result: CustomRunResult;
}

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<IndicatorWorkerRequest>) => void) | null;
  postMessage: (msg: IndicatorWorkerResponse) => void;
};

workerScope.onmessage = (ev: MessageEvent<IndicatorWorkerRequest>) => {
  const { reqId, code, candles, params } = ev.data;
  const result = runUserIndicator(code, candles, params);
  workerScope.postMessage({ reqId, result });
};
