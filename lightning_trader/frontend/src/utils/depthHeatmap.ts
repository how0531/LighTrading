/**
 * depthHeatmap.ts — 五檔委託牆熱力圖的純函式核心（Sprint D）
 *
 * DepthHeatmap 元件把「時間 × 價格」的掛量熱圖畫在 canvas 上；
 * 這裡負責所有可獨立測試的資料計算：
 *   - ring buffer：保留最近 N 筆五檔快照（純物件 + 函式維護，不進 React state）
 *   - 價格帶：以中價對齊 tick 網格、上下各 halfTicks 檔的固定視窗（隨中價平移）
 *   - 格子映射：任意掛單價 → 價格帶列索引（就近取整，容忍跨級距的微小偏移）
 *   - rolling max / 對數強度：格子顏色強度 = log1p(量) / log1p(視窗內最大量)，
 *     對數縮放讓單筆巨量掛單不會把其他格子全部壓成看不見
 */

/** 單筆五檔快照（取樣當下的盤口 + 成交價） */
export interface DepthSnapshot {
  /** epoch ms（僅供除錯 / 未來畫時間刻度；繪製以欄位序為準） */
  time: number;
  bidPrices: number[];
  bidVols: number[];
  askPrices: number[];
  askVols: number[];
  /** 取樣當下成交價（0 = 未知，白色軌跡線跳過該欄） */
  price: number;
}

/** ring buffer：snaps 恆為 oldest → newest，長度 ≤ cap */
export interface DepthRing {
  cap: number;
  snaps: DepthSnapshot[];
}

/** 預設保留 180 列快照（500ms 取樣 → 約 90 秒視窗） */
export const DEFAULT_RING_CAP = 180;

export function createDepthRing(cap: number = DEFAULT_RING_CAP): DepthRing {
  return { cap: Math.max(1, Math.floor(cap)), snaps: [] };
}

/**
 * 推入一筆快照；超過容量丟掉最舊的。
 * cap ≤ 180、取樣頻率 2Hz，splice 開銷可忽略（不需要 head-index 環狀結構）。
 */
export function pushDepthSnapshot(ring: DepthRing, snap: DepthSnapshot): void {
  ring.snaps.push(snap);
  if (ring.snaps.length > ring.cap) {
    ring.snaps.splice(0, ring.snaps.length - ring.cap);
  }
}

export function clearDepthRing(ring: DepthRing): void {
  ring.snaps.length = 0;
}

/** 價格對齊到 tick 網格（四捨五入到最近的 tick 倍數；1e-6 消浮點漂移） */
export function alignToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  return Math.round(Math.round(price / tick) * tick * 1e6) / 1e6;
}

/** 固定視窗價格帶：top = 對齊後中價 + halfTicks*tick，往下共 halfTicks*2+1 列 */
export interface PriceBand {
  /** 第 0 列的價格（最高價） */
  top: number;
  tick: number;
  rowCount: number;
}

/**
 * 以中價為中心建立 ±halfTicks 的價格帶。中價先對齊 tick 網格，
 * 所以中價小幅波動（同一 tick 內）不會讓整個視窗抖動；跨 tick 才平移一列。
 * mid / tick 無效回 null（無資料時元件不畫）。
 */
export function buildPriceBand(mid: number, tick: number, halfTicks: number): PriceBand | null {
  if (!(mid > 0) || !(tick > 0) || !(halfTicks >= 0)) return null;
  const alignedMid = alignToTick(mid, tick);
  const top = Math.round((alignedMid + halfTicks * tick) * 1e6) / 1e6;
  return { top, tick, rowCount: halfTicks * 2 + 1 };
}

/**
 * 掛單價 → 價格帶列索引（0 = 最高價列）。
 * 就近取整：跨級距邊界（例如台股 99.9 vs 100.5）造成的半格偏移落到最近列。
 * 超出視窗回 -1（呼叫端直接略過該檔）。
 */
export function priceToRow(price: number, band: PriceBand): number {
  if (!(price > 0)) return -1;
  const row = Math.round((band.top - price) / band.tick);
  return row >= 0 && row < band.rowCount ? row : -1;
}

/** 列索引 → 價格（畫 Y 軸標籤用） */
export function rowToPrice(row: number, band: PriceBand): number {
  return Math.round((band.top - row * band.tick) * 1e6) / 1e6;
}

/**
 * 視窗內所有快照、所有檔位的最大掛量（rolling max）。
 * 沒有任何正掛量時回 1（除零保護；此時所有強度都是 0）。
 */
export function rollingMaxVolume(snaps: DepthSnapshot[]): number {
  let max = 0;
  for (const s of snaps) {
    for (const v of s.bidVols) if (v > max) max = v;
    for (const v of s.askVols) if (v > max) max = v;
  }
  return max > 0 ? max : 1;
}

/**
 * 掛量 → 顏色強度 0..1。對數縮放：intensity = log1p(vol) / log1p(max)。
 * 相比線性（vol/max），單筆尖峰巨量不會把其餘格子全部壓到近乎透明。
 */
export function logIntensity(vol: number, maxVol: number): number {
  if (!(vol > 0)) return 0;
  const denom = Math.log1p(Math.max(maxVol, 1));
  if (denom <= 0) return 0;
  return Math.min(1, Math.log1p(vol) / denom);
}
