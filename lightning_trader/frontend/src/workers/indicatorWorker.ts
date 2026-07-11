/**
 * indicatorWorker.ts — 自訂 JS 指標的 Web Worker 沙箱（Sprint E）
 *
 * Vite module worker：new Worker(new URL('./indicatorWorker.ts', import.meta.url), { type: 'module' })
 * 可直接 import utils/customIndicator（其內委派 utils/indicators 的 ta 純函式）。
 *
 * 誠實聲明：瀏覽器內對任意使用者 JS 做「完美」沙箱在沒有真正解譯器
 * （quickjs-wasm 等）下並不可能。本檔是縱深防禦，不宣稱牢不可破。
 *
 * 沙箱紀律（本檔負責的那層，順序至關重要）：
 *   0. 先捕獲回傳訊息所需的 postMessage / addEventListener 綁定參照，
 *      並用 addEventListener 註冊訊息 handler（已註冊的 listener 之後即使
 *      把 addEventListener/postMessage 屬性清成 undefined 仍會觸發）。
 *   1. poisonConstructorChain()：毒化 Function/async/generator 的
 *      prototype.constructor（封死 (function(){}).constructor('return this')()
 *      這類拿回真實全域的路徑）。在任何使用者代碼執行前。
 *   2. 全域能力清空：把 worker global 上的網路/儲存/巢狀 worker/blob/url 等
 *      危險能力（明確黑名單，涵蓋原型上的方法）defineProperty 成 undefined
 *      且 configurable:false；再掃 own-enumerable 屬性刪掉洩漏的裸全域。
 *      → 即使使用者透過殘餘手段拿回 self，self 上也已無 fetch/Worker/Blob/
 *        URL/XMLHttpRequest/WebSocket... 可用（封死巢狀 worker 復活網路）。
 *   3. 使用者代碼 throw → runUserIndicator 內攔截，回傳 {error}。
 *   4. 無窮迴圈防護在主執行緒側（indicatorWorkerClient）：逾時 → terminate。
 *
 * 殘餘風險（誠實）：module worker 的 dynamic import() 是語法、無法刪除；
 * 惡意代碼理論上可 import() 遠端/blob module。緩解靠 index.html 的 CSP
 * （worker-src/child-src/object-src）——但 meta CSP 對「worker 內」發起的
 * import()/fetch 的涵蓋在各瀏覽器不一致，故最終仰賴上述能力清空。
 */
import {
  runUserIndicator,
  poisonConstructorChain,
  type CustomRunResult,
} from '../utils/customIndicator';
import type { Candle } from '../utils/indicators';

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

const g = self as unknown as Record<string, unknown> & {
  postMessage: (msg: IndicatorWorkerResponse) => void;
  addEventListener: (t: string, l: (ev: MessageEvent<IndicatorWorkerRequest>) => void) => void;
};

// ── 0. 捕獲回傳管道並註冊 handler（先於任何清空）────────────────────────
const realPostMessage = g.postMessage.bind(self) as (msg: IndicatorWorkerResponse) => void;
const realAddEventListener = g.addEventListener.bind(self);
realAddEventListener('message', (ev: MessageEvent<IndicatorWorkerRequest>) => {
  const { reqId, code, candles, params } = ev.data;
  const result = runUserIndicator(code, candles, params);
  realPostMessage({ reqId, result });
});

// ── 1. 毒化 constructor chain（在任何使用者代碼前）──────────────────────
poisonConstructorChain();

// ── 2. 全域能力清空 ────────────────────────────────────────────────────
// (a) 明確黑名單：涵蓋原型上的方法（getOwnPropertyNames(self) 抓不到繼承屬性，
//     故網路/worker/blob 這類定義在 *GlobalScope.prototype 上的能力靠此清）。
const DANGEROUS = [
  // 網路
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'Request', 'Response', 'Headers', 'FormData',
  'ReadableStream', 'WritableStream', 'TransformStream',
  // 巢狀 worker / blob / url（避免開新 worker 復活網路）
  'Worker', 'SharedWorker', 'ServiceWorker',
  'Blob', 'File', 'FileReader', 'FileReaderSync',
  'URL', 'webkitURL', 'createImageBitmap',
  'MessageChannel', 'MessagePort', 'BroadcastChannel',
  'importScripts',
  // 儲存
  'indexedDB', 'caches', 'localStorage', 'sessionStorage', 'cookieStore',
  // 環境 / 訊息面（已捕獲 realPostMessage/realAddEventListener,可安全清）
  'navigator', 'location', 'postMessage', 'close',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'onmessage', 'onmessageerror', 'onerror',
  // 其他可疑能力
  'WebAssembly', 'SharedArrayBuffer', 'Atomics',
  'crypto', 'Notification', 'reportError',
  // 直接執行任意碼的建構子（harness 用捕獲的 RealFunction,不受影響）
  'eval', 'Function',
];
for (const key of DANGEROUS) {
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

// (b) own-enumerable 掃描：刪掉任何洩漏到 worker global 的裸全域（保留自我參照
//     與 console/計時器等無害工具）。原生內建（Object/Array/Math…）為
//     non-enumerable,不會被 Object.keys 掃到,故此步不會誤刪 harness 需要的建構子。
const KEEP_ENUMERABLE = new Set(['self', 'globalThis', 'console', 'name']);
for (const key of Object.keys(g)) {
  if (KEEP_ENUMERABLE.has(key)) continue;
  try {
    Object.defineProperty(g, key, { value: undefined, configurable: false, writable: false });
  } catch {
    try {
      g[key] = undefined;
    } catch {
      /* 無法刪 → 略過 */
    }
  }
}
