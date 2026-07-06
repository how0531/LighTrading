/**
 * DepthHeatmap — 五檔委託牆熱力圖（Sprint D）
 *
 * 時間 × 價格的 canvas 熱圖，資料源＝當前主商品的五檔（useQuotes 的 bidAsk）＋
 * 現價（quote.Price，畫白色軌跡線）。
 *
 * 取樣策略：固定 500ms 節流取樣（非「每次五檔更新」）——
 *   - X 軸時間刻度均勻（無更新時沿用最新盤口重複取樣，牆的「持續存在」看得見）
 *   - 180 列 ring buffer ≈ 90 秒視窗；ring 由 utils/depthHeatmap 純函式維護，
 *     存在 ref、不進 React state
 *
 * 繪製：取樣 tick 內直接重畫整張 canvas（2Hz、單張 ≤ 千餘個 fillRect，遠低於
 * rAF 需求；「不用 DOM 元素畫格子」的效能紀律由 canvas 保證）。
 * Y 軸價格帶 = 中價（現價 > 買賣一中點 > 參考價）對齊 tick 網格 ±HALF_TICKS，
 * 隨中價平移；顏色強度 = log1p(掛量) / log1p(視窗 rolling max)，
 * 買側紅、賣側綠（本專案買紅賣綠慣例）。
 *
 * 元件 React.memo 隔離、只訂 QuotesContext（targetSymbol 由 DOMPanel 以 prop 傳入，
 * 避免多掛一個 core context 訂閱）。
 */
import React, { useEffect, useRef } from 'react';
import { useQuotes } from '../../contexts/TradingContext';
import { getTickSize, formatPrice } from '../../utils/instrument';
import {
  createDepthRing, pushDepthSnapshot, clearDepthRing,
  buildPriceBand, priceToRow, rowToPrice,
  rollingMaxVolume, logIntensity,
  DEFAULT_RING_CAP,
  type DepthSnapshot,
} from '../../utils/depthHeatmap';

const SAMPLE_MS = 500;          // 取樣 & 重繪節流
const HALF_TICKS = 12;          // 中價 ±12 tick 固定視窗 → 25 列
const CANVAS_H = 150;           // css px（25 列 × 6px）
const LABEL_W = 46;             // 右側價格標籤保留區

interface DepthHeatmapProps {
  targetSymbol: string;
}

const DepthHeatmapInner: React.FC<DepthHeatmapProps> = ({ targetSymbol }) => {
  const { quote, bidAsk } = useQuotes();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ringRef = useRef(createDepthRing(DEFAULT_RING_CAP));

  // onmessage → 100ms flush 進 context；這裡再鏡射進 ref，
  // 讓 500ms 取樣器讀「最新值」而不用把 interval 綁進 quote 依賴（避免反覆重建 timer）
  const latestRef = useRef<{ bidAsk: typeof bidAsk; price: number; reference: number }>({
    bidAsk: null, price: 0, reference: 0,
  });
  useEffect(() => {
    latestRef.current = {
      bidAsk,
      price: quote?.Price ?? 0,
      reference: quote?.Reference ?? 0,
    };
  }, [bidAsk, quote]);

  // 切換商品：清空 ring（舊商品的價格帶完全不相干）
  useEffect(() => {
    clearDepthRing(ringRef.current);
  }, [targetSymbol]);

  useEffect(() => {
    const paint = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      const cssW = Math.max(120, parent ? parent.clientWidth : 300);
      const dpr = window.devicePixelRatio || 1;
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(CANVAS_H * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
        canvas.style.height = `${CANVAS_H}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, CANVAS_H);
      ctx.fillStyle = '#0b101b';
      ctx.fillRect(0, 0, cssW, CANVAS_H);

      const snaps = ringRef.current.snaps;
      if (snaps.length === 0) return;

      // 價格帶：最新取樣的中價（現價 > 買賣一中點）對齊 tick，±HALF_TICKS 平移視窗
      const last = snaps[snaps.length - 1];
      const bid1 = last.bidPrices[0] || 0;
      const ask1 = last.askPrices[0] || 0;
      const mid = last.price > 0
        ? last.price
        : (bid1 > 0 && ask1 > 0 ? (bid1 + ask1) / 2 : (bid1 || ask1));
      const tick = getTickSize(mid || 1, targetSymbol);
      const band = buildPriceBand(mid, tick, HALF_TICKS);
      if (!band) return;

      const plotW = cssW - LABEL_W;
      const colW = plotW / ringRef.current.cap;
      const rowH = CANVAS_H / band.rowCount;
      const maxVol = rollingMaxVolume(snaps);

      // 熱圖格子：X 右緣 = 最新，往左流動
      for (let i = 0; i < snaps.length; i++) {
        const s = snaps[i];
        const x = plotW - (snaps.length - i) * colW;
        for (let l = 0; l < s.bidPrices.length; l++) {
          const row = priceToRow(s.bidPrices[l], band);
          if (row < 0) continue;
          const a = logIntensity(s.bidVols[l] || 0, maxVol);
          if (a <= 0) continue;
          ctx.fillStyle = `rgba(239,68,68,${(0.12 + 0.88 * a).toFixed(3)})`; // 買側紅
          ctx.fillRect(x, row * rowH, Math.max(colW, 1), rowH - 0.5);
        }
        for (let l = 0; l < s.askPrices.length; l++) {
          const row = priceToRow(s.askPrices[l], band);
          if (row < 0) continue;
          const a = logIntensity(s.askVols[l] || 0, maxVol);
          if (a <= 0) continue;
          ctx.fillStyle = `rgba(16,185,129,${(0.12 + 0.88 * a).toFixed(3)})`; // 賣側綠
          ctx.fillRect(x, row * rowH, Math.max(colW, 1), rowH - 0.5);
        }
      }

      // 白色成交價軌跡線（取樣時 price=0 的欄跳過 → 斷線）
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < snaps.length; i++) {
        const s = snaps[i];
        if (!(s.price > 0)) { pen = false; continue; }
        const row = priceToRow(s.price, band);
        if (row < 0) { pen = false; continue; }
        const x = plotW - (snaps.length - i) * colW + colW / 2;
        const y = row * rowH + rowH / 2;
        if (pen) ctx.lineTo(x, y);
        else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();

      // 右側價格標籤：頂 / 中 / 底
      ctx.font = '9px ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(148,163,184,0.9)';
      const labelRows = [0, Math.floor(band.rowCount / 2), band.rowCount - 1];
      for (const r of labelRows) {
        ctx.fillText(
          formatPrice(rowToPrice(r, band), targetSymbol),
          plotW + 4,
          Math.min(CANVAS_H - 6, Math.max(6, r * rowH + rowH / 2)),
        );
      }
    };

    const timer = setInterval(() => {
      const { bidAsk: book, price } = latestRef.current;
      if (book && (Array.isArray(book.BidPrice) || Array.isArray(book.AskPrice))) {
        const snap: DepthSnapshot = {
          time: Date.now(),
          bidPrices: (book.BidPrice || []).map(Number),
          bidVols: (book.BidVolume || []).map(Number),
          askPrices: (book.AskPrice || []).map(Number),
          askVols: (book.AskVolume || []).map(Number),
          price,
        };
        pushDepthSnapshot(ringRef.current, snap);
      }
      paint();
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [targetSymbol]);

  return (
    <div
      className="shrink-0 border-b border-slate-800 bg-[#0b101b] px-2 pt-1 pb-1.5"
      data-testid="depth-heatmap"
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
          委託牆 · {targetSymbol} · 中價±{HALF_TICKS} tick · ~90s
        </span>
        <span className="text-[9px] text-slate-600 hidden md:block">
          <span className="text-red-400/80">■ 買</span>
          <span className="ml-1.5 text-emerald-400/80">■ 賣</span>
          <span className="ml-1.5 text-slate-400">— 成交價</span>
        </span>
      </div>
      <canvas ref={canvasRef} className="w-full block rounded-sm" style={{ height: CANVAS_H }} />
    </div>
  );
};

// 只吃 QuotesContext 的 tick flush；props 僅 targetSymbol（string）→ memo 可擋掉父層其他重繪
export const DepthHeatmap = React.memo(DepthHeatmapInner);
DepthHeatmap.displayName = 'DepthHeatmap';
