/**
 * CustomIndicatorEditor — 自訂 JS 指標編輯器（Sprint E）
 *
 * 等寬字體 textarea（不引入編輯器依賴）+ 範例模板（註解教學）。
 * 「驗證」把代碼丟進 indicatorWorker（Web Worker 沙箱,2s timeout）
 * 對當前 K 棒資料試跑：成功 → 顯示偵測到的輸出線/參數,「儲存」啟用；
 * 失敗 → 顯示錯誤訊息與行號 hint。儲存後出現在 picker「自訂」分頁。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Play, Save, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Candle } from '../utils/indicators';
import {
  parseParamComments,
  syntheticCandles,
  type CustomRunResult,
} from '../utils/customIndicator';
import { defaultParamsOf, type IndicatorParamDef } from '../utils/indicatorRegistry';
import { IndicatorWorkerClient } from '../utils/indicatorWorkerClient';
import {
  newCustomId,
  type CustomIndicatorDef,
  type CustomLineMeta,
} from '../utils/chartIndicatorSettings';

const TEMPLATE_CODE = `// 自訂指標範例：雙均線（主圖）+ 乖離柱（副圖）
// ── 可用變數 ─────────────────────────────────────────
//   candles                K 棒陣列 [{time, open, high, low, close, volume}]
//   close/open/high/low/volume/time   與 K 棒等長的數值陣列
//   params                 參數物件（由下方 @param 宣告）
// ── 可用工具 ta.* ────────────────────────────────────
//   ta.sma/ema/wma/rsi/stdev/highest/lowest(src, period)
//   ta.change(src, n) / ta.roc(src, n)
//   ta.crossover(a, b) / ta.crossunder(a, b)   → boolean[]
//   ta.atr(period) / ta.tr()                   （綁定當前 K 棒）
//   （輸入輸出都是與 K 棒等長的陣列,暖身期為 NaN,畫圖時自動略過）
// ── 輸出 ────────────────────────────────────────────
//   plot(名稱, 數列, { color, style: 'line'|'histogram', pane: 'main'|'sub' })
//   hline(數值, { color })      在副圖畫水平參考線
// ── 參數宣告（會出現在指標設定表單） ──────────────────
//@param fast 5 1 120 快線週期
//@param slow 20 1 240 慢線週期

const fastMa = ta.sma(close, params.fast);
const slowMa = ta.sma(close, params.slow);
plot('快線', fastMa, { color: '#60a5fa', pane: 'main' });
plot('慢線', slowMa, { color: '#fb923c', pane: 'main' });
// 乖離（快-慢）畫在副圖 histogram
plot('乖離', fastMa.map((v, i) => v - slowMa[i]), { style: 'histogram', color: '#4ade80' });
hline(0, { color: '#64748b' });
`;

interface CustomIndicatorEditorProps {
  /** null = 新增；否則編輯既有 */
  def: CustomIndicatorDef | null;
  getBars: () => Candle[];
  onClose: () => void;
  onSave: (def: CustomIndicatorDef) => void;
}

const CustomIndicatorEditor: React.FC<CustomIndicatorEditorProps> = ({
  def, getBars, onClose, onSave,
}) => {
  const [name, setName] = useState(def?.name ?? '我的指標');
  const [code, setCode] = useState(def?.code ?? TEMPLATE_CODE);
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState<CustomRunResult | null>(null);
  /** 通過驗證的代碼（code 再被改動就要重新驗證） */
  const [validatedCode, setValidatedCode] = useState<string | null>(null);

  const workerRef = useRef<IndicatorWorkerClient | null>(null);
  useEffect(() => {
    return () => {
      workerRef.current?.dispose();
      workerRef.current = null;
    };
  }, []);

  const detectedParams: IndicatorParamDef[] = useMemo(() => parseParamComments(code), [code]);

  const validate = async () => {
    setValidating(true);
    setResult(null);
    if (!workerRef.current) workerRef.current = new IndicatorWorkerClient();
    const bars = getBars();
    const testBars = bars.length >= 30 ? bars : syntheticCandles();
    const res = await workerRef.current.run(code, testBars, defaultParamsOf(detectedParams));
    setValidating(false);
    setResult(res);
    setValidatedCode(res.error ? null : code);
  };

  const canSave = validatedCode === code && !!result && !result.error && !!name.trim();

  const save = () => {
    if (!canSave || !result) return;
    const lines: CustomLineMeta[] = result.plots.map((pl) => ({
      name: pl.name,
      style: pl.style,
      pane: pl.pane,
      ...(pl.color ? { color: pl.color } : {}),
    }));
    onSave({
      id: def?.id ?? newCustomId(),
      name: name.trim(),
      code,
      params: detectedParams,
      lines,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      // stopPropagation：editor 疊在 picker overlay 內,點背景只關 editor 不關 picker
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        className="relative w-full max-w-2xl h-[640px] max-h-[92vh] flex flex-col overflow-hidden bg-[#1C2331] border border-[#29344A] rounded-xl shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 flex items-center justify-between px-4 border-b border-[#29344A] flex-shrink-0">
          <h2 className="text-sm font-bold text-white tracking-wide">
            {def ? '編輯自訂指標' : '新增自訂指標'}
            <span className="ml-2 text-[9px] text-slate-500 font-normal">
              Web Worker 沙箱執行 · 2s timeout · 無網路/儲存存取
            </span>
          </h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-white rounded" title="關閉">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
          <label className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400 flex-shrink-0">名稱</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 bg-[#101623] border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:border-[#D4AF37]/60 focus:outline-none"
              placeholder="指標名稱（顯示在 picker / legend）"
            />
          </label>

          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            className="flex-1 min-h-0 w-full bg-[#0B111C] border border-slate-700 rounded p-2 font-mono text-[11px] leading-relaxed text-slate-200 resize-none focus:border-[#D4AF37]/60 focus:outline-none whitespace-pre overflow-auto"
          />

          {/* 驗證結果 */}
          <div className="min-h-[84px] max-h-[150px] overflow-y-auto rounded border border-slate-800 bg-slate-900/40 p-2 text-[11px]">
            {!result && !validating && (
              <div className="text-slate-600">
                按「驗證」以當前 K 棒資料試跑（圖表無資料時用合成資料）。
                {detectedParams.length > 0 && (
                  <div className="mt-1 text-slate-500">
                    偵測到參數：{detectedParams.map((p) => `${p.label}=${p.default} [${p.min}–${p.max}]`).join('、')}
                  </div>
                )}
              </div>
            )}
            {validating && <div className="text-slate-400">驗證中（worker 執行,逾時 2 秒自動中止）…</div>}
            {result?.error && (
              <div className="text-red-400 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-bold">
                    驗證失敗{result.errorLine ? `（約第 ${result.errorLine} 行）` : ''}
                  </div>
                  <div className="text-red-300/80 whitespace-pre-wrap break-all">{result.error}</div>
                </div>
              </div>
            )}
            {result && !result.error && (
              <div className="text-emerald-400">
                <div className="flex items-center gap-1.5 font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  驗證通過 — 偵測到 {result.plots.length} 條輸出線
                  {result.hlines.length > 0 ? `、${result.hlines.length} 條水平線` : ''}
                </div>
                <ul className="mt-1 space-y-0.5 text-slate-300">
                  {result.plots.map((pl) => (
                    <li key={pl.name} className="flex items-center gap-1.5">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                        style={{ backgroundColor: pl.color ?? '#60a5fa' }}
                      />
                      {pl.name}
                      <span className="text-slate-600">
                        {pl.style === 'histogram' ? 'histogram' : 'line'} · {pl.pane === 'main' ? '主圖' : '副圖'}
                        · {pl.points.length} 點
                      </span>
                    </li>
                  ))}
                </ul>
                {detectedParams.length > 0 && (
                  <div className="mt-1 text-slate-500">
                    參數：{detectedParams.map((p) => `${p.label}=${p.default}`).join('、')}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            {validatedCode !== null && validatedCode !== code && (
              <span className="text-[10px] text-amber-400 mr-auto">代碼已修改——請重新驗證</span>
            )}
            <button
              onClick={validate}
              disabled={validating}
              className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold rounded border bg-slate-900 text-slate-200 border-slate-600 hover:border-[#D4AF37]/60 disabled:opacity-40 transition-colors"
            >
              <Play className="w-3 h-3" /> 驗證
            </button>
            <button
              onClick={save}
              disabled={!canSave}
              className="flex items-center gap-1 px-3 py-1.5 text-[11px] font-bold rounded border bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#D4AF37]/30 transition-colors"
              title={canSave ? '儲存並加入「自訂」分頁' : '需先驗證通過'}
            >
              <Save className="w-3 h-3" /> 儲存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CustomIndicatorEditor;
