/**
 * Panel_VWAP — VWAP 即時指標
 *
 * 當沖最常用的單一線：價在 VWAP 上 = 多方強勢 / 價在 VWAP 下 = 空方強勢。
 * 前端版本是「當下訂閱 session 累積」，跟後端 /api/vwap/{symbol} 結果可能略差
 * （後端從交易日開盤就開始累；前端從你訂閱該商品起算）。
 *
 * UI：
 *   - 大字顯示當前 VWAP
 *   - 與現價的距離（點數 + 百分比）
 *   - 強弱訊號（上方綠 / 下方紅）
 *   - 累計成交量（樣本可信度）
 */
import React from 'react';
import { useTradingContext } from '../contexts/TradingContext';

const Panel_VWAP: React.FC = () => {
  const { targetSymbol, vwap, vwapVolume, quote } = useTradingContext();
  const price = quote?.Price ?? 0;
  const diff = vwap != null && price > 0 ? price - vwap : null;
  const diffPct = diff != null && vwap! > 0 ? (diff / vwap!) * 100 : null;
  const side = diff == null ? null : diff > 0 ? 'above' : diff < 0 ? 'below' : 'flat';

  const sideClass = side === 'above'
    ? 'text-emerald-300'
    : side === 'below' ? 'text-rose-300' : 'text-slate-300';
  const arrow = side === 'above' ? '▲' : side === 'below' ? '▼' : '–';

  return (
    <div className="h-full flex flex-col bg-[#101623] text-slate-100 p-3">
      <div className="text-xs font-bold tracking-widest text-slate-300 mb-2 flex justify-between">
        <span>VWAP</span>
        <span className="text-slate-500">{targetSymbol}</span>
      </div>

      {vwap == null || vwap === 0 ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
          等待成交…
        </div>
      ) : (
        <>
          <div className="text-3xl font-mono font-bold text-amber-300">
            {vwap.toFixed(2)}
          </div>
          <div className={`mt-2 text-sm font-mono ${sideClass}`}>
            {arrow} {diff != null && (diff > 0 ? '+' : '')}{diff?.toFixed(2)}{' '}
            ({diffPct != null && (diffPct > 0 ? '+' : '')}{diffPct?.toFixed(2)}%)
          </div>
          <div className="mt-1 text-[11px] text-slate-500 font-mono">
            現價 {price.toFixed(2)} · 樣本量 {vwapVolume.toLocaleString()}
          </div>
          <div className={`mt-3 inline-block self-start px-2 py-0.5 rounded text-[10px] font-bold tracking-wide ${
            side === 'above' ? 'bg-emerald-500/20 text-emerald-300' :
            side === 'below' ? 'bg-rose-500/20 text-rose-300' :
            'bg-slate-500/20 text-slate-300'
          }`}>
            {side === 'above' ? '多方強勢' : side === 'below' ? '空方強勢' : '盤整'}
          </div>
        </>
      )}
    </div>
  );
};

export default Panel_VWAP;
