/**
 * LayOrdersPanel — 鋪單面板（Sprint C：靜態多價位 + 可選追價）
 *
 * 由 DOMFooter 的「鋪單」按鈕開啟的緊湊 section（貼在 ladder 與 footer 之間）。
 * 欄位：方向（買/賣）、檔數 N（2–10）、起始價（預設＝買→買一、賣→賣一；可手改）、
 *       間距（tick 數，預設 1）、每檔量（預設 1）、追價鋪單 checkbox。
 * 買單由起始價往下鋪、賣單往上鋪（computeLayPrices，貼齊 tick）。
 * 送出 / 中止 / 撤鋪單邏輯在 useLayOrders。
 */
import React, { useState } from 'react';
import { X, Layers, Trash2 } from 'lucide-react';
import type { BidAskData } from '../../types';
import { computeLayPrices } from '../../utils/layOrders';
import { formatPrice } from '../../utils/instrument';
import type { LayProgress, LaidOrderRef, LaySubmitParams } from '../../hooks/useLayOrders';

interface LayOrdersPanelProps {
  targetSymbol: string;
  currentPrice: number;
  bData: Partial<BidAskData>;
  orderCond: string;
  orderLot: string;
  layProgress: LayProgress | null;
  abortLay: () => void;
  submitLay: (params: LaySubmitParams) => Promise<boolean>;
  laidOrders: LaidOrderRef[];
  cancelLaid: () => Promise<void>;
  onClose: () => void;
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.floor(v) || lo));

export const LayOrdersPanel: React.FC<LayOrdersPanelProps> = ({
  targetSymbol, currentPrice, bData, orderCond, orderLot,
  layProgress, abortLay, submitLay, laidOrders, cancelLaid, onClose,
}) => {
  const [side, setSide] = useState<'Buy' | 'Sell'>('Buy');
  const [levels, setLevels] = useState(3);
  const [gapTicks, setGapTicks] = useState(1);
  const [qtyPerLevel, setQtyPerLevel] = useState(1);
  const [useChase, setUseChase] = useState(false);
  // 起始價：null = 自動跟盤口（買→買一、賣→賣一，缺盤口退回現價）；手改後固定
  const [manualStart, setManualStart] = useState<number | null>(null);

  const bid1 = Number(bData.BidPrice?.[0] ?? 0);
  const ask1 = Number(bData.AskPrice?.[0] ?? 0);
  const autoStart = (side === 'Buy' ? bid1 : ask1) || currentPrice || 0;
  const startPrice = manualStart ?? autoStart;

  const previewPrices = startPrice > 0
    ? computeLayPrices({ side, levels, startPrice, gapTicks, symbol: targetSymbol })
    : [];
  const previewText = previewPrices.length > 0
    ? `${formatPrice(previewPrices[0], targetSymbol)} → ${formatPrice(previewPrices[previewPrices.length - 1], targetSymbol)}（${previewPrices.length} 檔 × ${qtyPerLevel}）`
    : '—';

  const busy = layProgress != null;

  const onSubmit = async () => {
    await submitLay({
      side, levels, startPrice, gapTicks, qtyPerLevel, useChase,
      orderCond, orderLot,
    });
  };

  return (
    <div className="flex-shrink-0 border-t border-indigo-500/40 bg-indigo-950/30 px-3 py-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1 font-black text-indigo-300 uppercase tracking-wider text-[10px]">
          <Layers className="w-3.5 h-3.5" /> 鋪單
        </span>

        {/* 方向 */}
        <div className="flex rounded border border-slate-700 overflow-hidden">
          {(['Buy', 'Sell'] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setSide(s); setManualStart(null); }}
              disabled={busy}
              className={`px-2 py-0.5 font-bold transition-colors cursor-pointer ${
                side === s
                  ? s === 'Buy' ? 'bg-red-600/80 text-white' : 'bg-emerald-600/80 text-white'
                  : 'bg-[#101623] text-slate-400 hover:text-slate-200'
              }`}
            >
              {s === 'Buy' ? '買' : '賣'}
            </button>
          ))}
        </div>

        {/* 檔數 N */}
        <label className="flex items-center gap-1">
          <span className="text-slate-500 text-[10px]">檔數</span>
          <input
            type="number" min={2} max={10} value={levels} disabled={busy}
            onChange={(e) => setLevels(clampInt(Number(e.target.value), 2, 10))}
            className="w-11 bg-[#101623] border border-slate-700 rounded text-right text-slate-200 px-1 py-0.5"
          />
        </label>

        {/* 起始價（自動＝跟買一/賣一，可手改） */}
        <label className="flex items-center gap-1">
          <span className="text-slate-500 text-[10px]">起始價</span>
          <input
            type="number" step="any" value={startPrice || ''} disabled={busy}
            onChange={(e) => setManualStart(parseFloat(e.target.value || '0') || 0)}
            className={`w-16 bg-[#101623] border rounded text-right px-1 py-0.5 ${
              manualStart == null ? 'border-slate-700 text-indigo-300' : 'border-indigo-500/60 text-slate-200'
            }`}
            title={manualStart == null
              ? `自動：跟隨${side === 'Buy' ? '買一' : '賣一'}價（可直接輸入改為固定價）`
              : '手動固定起始價'}
          />
          {manualStart != null && (
            <button
              onClick={() => setManualStart(null)}
              disabled={busy}
              className="text-[10px] text-indigo-400 hover:text-indigo-200 cursor-pointer"
              title={`回到自動（跟隨${side === 'Buy' ? '買一' : '賣一'}）`}
            >
              自動
            </button>
          )}
        </label>

        {/* 間距 */}
        <label className="flex items-center gap-1">
          <span className="text-slate-500 text-[10px]">間距</span>
          <input
            type="number" min={1} max={50} value={gapTicks} disabled={busy}
            onChange={(e) => setGapTicks(clampInt(Number(e.target.value), 1, 50))}
            className="w-11 bg-[#101623] border border-slate-700 rounded text-right text-slate-200 px-1 py-0.5"
          />
          <span className="text-slate-600 text-[10px]">tick</span>
        </label>

        {/* 每檔量 */}
        <label className="flex items-center gap-1">
          <span className="text-slate-500 text-[10px]">每檔量</span>
          <input
            type="number" min={1} max={1000} value={qtyPerLevel} disabled={busy}
            onChange={(e) => setQtyPerLevel(clampInt(Number(e.target.value), 1, 1000))}
            className="w-12 bg-[#101623] border border-slate-700 rounded text-right text-slate-200 px-1 py-0.5"
          />
        </label>

        {/* 追價鋪單 */}
        <label className="flex items-center gap-1 cursor-pointer select-none" title="勾選後每檔改送 CHASE 追價智慧單（後端依盤口自動改價追進）">
          <input
            type="checkbox" checked={useChase} disabled={busy}
            onChange={(e) => setUseChase(e.target.checked)}
            className="accent-sky-400 cursor-pointer"
          />
          <span className={`text-[10px] font-bold ${useChase ? 'text-sky-300' : 'text-slate-400'}`}>追價鋪單</span>
        </label>

        {/* 預覽：方向 + 價格區間 */}
        <span className="text-[10px] font-mono tabular-nums text-slate-400" title="買單由起始價往下鋪、賣單往上鋪（貼齊 tick）">
          {side === 'Buy' ? '↓' : '↑'} {previewText}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {/* 進度 + 中止（獨立 layProgress，不與拆單進度打架） */}
          {layProgress && !layProgress.aborted && (
            <>
              <span className="text-[10px] font-black text-indigo-300 tabular-nums whitespace-nowrap">
                鋪單 {layProgress.sent}/{layProgress.total}
              </span>
              <div className="w-20 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-indigo-400 transition-all duration-200"
                  style={{ width: `${(layProgress.sent / Math.max(1, layProgress.total)) * 100}%` }}
                />
              </div>
              <button
                onClick={abortLay}
                className="px-2 py-0.5 rounded text-[10px] font-black bg-red-900/40 hover:bg-red-800/60 text-red-300 border border-red-800/60 transition-colors cursor-pointer"
                title="停止送出剩餘檔位（已送出的不受影響）"
              >
                中止
              </button>
            </>
          )}
          {!busy && (
            <button
              onClick={onSubmit}
              disabled={!targetSymbol || !(startPrice > 0)}
              className="px-3 py-0.5 rounded text-[11px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title={!(startPrice > 0) ? '尚無起始價（等報價或手動輸入）' : '送出前會再做一次總確認'}
            >
              鋪單
            </button>
          )}
          {laidOrders.length > 0 && (
            <button
              onClick={cancelLaid}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-900/40 hover:bg-red-800/60 text-red-300 border border-red-800/60 transition-colors cursor-pointer disabled:opacity-40"
              title="一鍵撤掉本次鋪出的所有委託（普通單走刪單、追價單走智慧單取消）"
            >
              <Trash2 className="w-3 h-3" /> 撤鋪單 ({laidOrders.length})
            </button>
          )}
          <button
            onClick={onClose}
            className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700/60 transition-colors cursor-pointer"
            title="收合鋪單面板"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-1 text-[9px] text-slate-600 italic">
        鋪單記憶僅存於本頁（重新整理即失去「撤鋪單」對象）；撤鋪單：普通單依價位走刪單 API、追價單走智慧單取消。
      </div>
    </div>
  );
};
