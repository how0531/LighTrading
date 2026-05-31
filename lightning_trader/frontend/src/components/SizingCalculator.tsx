/**
 * SizingCalculator — 基於風險金額算出建議口數
 *
 * 三個輸入：risk_amount / entry / stop
 * 算出：qty + 實際冒險金額 + 單口風險 + 警告
 *
 * 為什麼這個重要：當沖紀律的第一步是「先決定要冒多少錢，再算口數」，
 * 而不是先決定口數再被動承擔風險。沒有這個工具，使用者只能心算。
 */
import React, { useState } from 'react';
import { calcQty, type CalcQtyResult } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';

const SizingCalculator: React.FC = () => {
  const { targetSymbol, quote } = useTradingContext();
  const [risk, setRisk] = useState<string>('2000');
  const [entry, setEntry] = useState<string>(() => quote?.Price ? String(quote.Price) : '');
  const [stop, setStop] = useState<string>('');
  const [maxQty, setMaxQty] = useState<string>('10');
  const [result, setResult] = useState<CalcQtyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const calc = async () => {
    setErr(null); setResult(null);
    const r = parseFloat(risk);
    const e = parseFloat(entry);
    const s = parseFloat(stop);
    const m = parseInt(maxQty, 10);
    if (!Number.isFinite(r) || r <= 0) return setErr('風險金額需 > 0');
    if (!Number.isFinite(e) || e <= 0) return setErr('進場價需 > 0');
    if (!Number.isFinite(s) || s <= 0) return setErr('停損價需 > 0');
    if (e === s) return setErr('進場價與停損價不可相同');
    try {
      setLoading(true);
      const res = await calcQty({
        symbol: targetSymbol,
        risk_amount: r,
        entry_price: e,
        stop_price: s,
        max_qty: Number.isFinite(m) && m > 0 ? m : 10,
      });
      setResult(res);
    } catch (e: any) {
      setErr(e?.response?.data?.detail?.user_msg || '計算失敗');
    } finally {
      setLoading(false);
    }
  };

  const useCurrent = () => {
    if (quote?.Price) setEntry(String(quote.Price));
  };

  return (
    <div className="h-full flex flex-col bg-[#101623] text-slate-100 p-3 gap-3 overflow-y-auto">
      <div className="text-xs font-bold tracking-widest text-slate-300 flex justify-between">
        <span>SIZING</span>
        <span className="text-slate-500">{targetSymbol}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">風險金額 (NT$)</span>
          <input className="bg-slate-800 px-2 py-1 rounded font-mono"
                 value={risk} onChange={e => setRisk(e.target.value)} type="number" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">上限口數</span>
          <input className="bg-slate-800 px-2 py-1 rounded font-mono"
                 value={maxQty} onChange={e => setMaxQty(e.target.value)} type="number" />
        </label>
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-slate-400 flex justify-between">
            進場價
            <button type="button" onClick={useCurrent}
              className="text-amber-400 hover:underline disabled:text-slate-600"
              disabled={!quote?.Price}>
              用現價 {quote?.Price?.toFixed(2)}
            </button>
          </span>
          <input className="bg-slate-800 px-2 py-1 rounded font-mono"
                 value={entry} onChange={e => setEntry(e.target.value)} type="number" />
        </label>
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-slate-400">停損價</span>
          <input className="bg-slate-800 px-2 py-1 rounded font-mono"
                 value={stop} onChange={e => setStop(e.target.value)} type="number" />
        </label>
      </div>

      <button onClick={calc} disabled={loading}
              className="bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold py-1.5 rounded text-sm disabled:bg-slate-700">
        {loading ? '計算中…' : '計算'}
      </button>

      {err && <div className="text-rose-400 text-xs">{err}</div>}

      {result && (
        <div className="mt-1 p-3 bg-slate-800/60 rounded space-y-1 font-mono text-xs">
          <div className="flex justify-between text-base font-bold">
            <span className="text-slate-300">建議口數</span>
            <span className={result.qty > 0 ? 'text-amber-300' : 'text-slate-500'}>{result.qty}</span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>單口風險</span><span>{result.risk_per_qty.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>實際冒險</span><span>{result.actual_risk.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>距離</span><span>{result.distance.toFixed(2)} 點 × {result.multiplier}</span>
          </div>
          {result.warnings.length > 0 && (
            <ul className="mt-2 text-amber-300 text-[11px] list-disc list-inside">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default SizingCalculator;
