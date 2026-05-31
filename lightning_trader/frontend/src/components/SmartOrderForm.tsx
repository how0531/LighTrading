/**
 * SmartOrderForm — OCO / Bracket / Scale-out 三模式
 *
 * - OCO       ：已有部位，掛停利停損二擇一
 * - Bracket   ：尚未進場，限價單成交後自動掛 OCO
 * - Scale-out ：已有部位，按多個價位分批出場 + 共用停損 + 可選 trailing runner
 */
import React, { useState } from 'react';
import { addOCO, addBracket, addScaleOut } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';

type Mode = 'oco' | 'bracket' | 'scaleout';

const SmartOrderForm: React.FC = () => {
  const { targetSymbol } = useTradingContext();
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>('oco');
  const [action, setAction] = useState<'Buy' | 'Sell'>('Sell');
  const [qty, setQty] = useState('1');
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [entry, setEntry] = useState('');

  // Scale-out 專用：最多 3 段 target
  const [targets, setTargets] = useState<{ price: string; qty: string }[]>([
    { price: '', qty: '1' }, { price: '', qty: '1' }
  ]);
  const [runnerTrailing, setRunnerTrailing] = useState('0');

  const submit = async () => {
    const q = parseInt(qty, 10);
    const tpN = parseFloat(tp);
    const slN = parseFloat(sl);
    try {
      if (mode === 'oco') {
        if (!q || !tpN || !slN) return toast.error('qty / TP / SL 都需要填', '欄位不完整');
        await addOCO({ symbol: targetSymbol, action, qty: q, take_profit: tpN, stop_loss: slN });
        toast.success('OCO 已設定');
      } else if (mode === 'bracket') {
        const eN = parseFloat(entry);
        if (!q || !eN || !tpN || !slN) return toast.error('進場、TP、SL 都需要填');
        await addBracket({ symbol: targetSymbol, action, qty: q, entry_price: eN, take_profit: tpN, stop_loss: slN });
        toast.success('Bracket 已設定');
      } else {
        const tList = targets
          .map(t => ({ price: parseFloat(t.price), qty: parseInt(t.qty, 10) }))
          .filter(t => Number.isFinite(t.price) && t.price > 0 && t.qty > 0);
        if (tList.length === 0) return toast.error('至少要填一個 target');
        if (!slN) return toast.error('Scale-out 必須有共用停損');
        const rt = parseFloat(runnerTrailing) || 0;
        await addScaleOut({
          symbol: targetSymbol, action,
          targets: tList, stop_loss: slN, runner_trailing: rt,
        });
        toast.success(`Scale-out 已設定 (${tList.length} 段 + stop${rt > 0 ? ' + runner' : ''})`);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.detail?.user_msg || '送出失敗');
    }
  };

  const TabBtn: React.FC<{ m: Mode; label: string }> = ({ m, label }) => (
    <button
      onClick={() => setMode(m)}
      className={`flex-1 px-2 py-1 text-xs font-bold tracking-wider rounded-t transition-colors ${
        mode === m ? 'bg-slate-700 text-amber-300' : 'bg-slate-800 text-slate-400 hover:text-slate-200'
      }`}
    >{label}</button>
  );

  const Input: React.FC<{ label: string; value: string; on: (v: string) => void; type?: string }> = ({ label, value, on, type = 'number' }) => (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-slate-400">{label}</span>
      <input className="bg-slate-800 px-2 py-1 rounded font-mono"
             value={value} onChange={e => on(e.target.value)} type={type} />
    </label>
  );

  return (
    <div className="h-full flex flex-col bg-[#101623] text-slate-100 p-3 gap-3 overflow-y-auto">
      <div className="text-xs font-bold tracking-widest text-slate-300 flex justify-between">
        <span>SMART ORDER</span>
        <span className="text-slate-500">{targetSymbol}</span>
      </div>

      <div className="flex gap-1">
        <TabBtn m="oco" label="OCO" />
        <TabBtn m="bracket" label="BRACKET" />
        <TabBtn m="scaleout" label="SCALE-OUT" />
      </div>

      <div className="flex gap-1 text-xs">
        <button onClick={() => setAction('Buy')}
          className={`flex-1 py-1 rounded font-bold ${action === 'Buy' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
          BUY (空單平倉 / 進多)
        </button>
        <button onClick={() => setAction('Sell')}
          className={`flex-1 py-1 rounded font-bold ${action === 'Sell' ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
          SELL (多單平倉 / 進空)
        </button>
      </div>

      {mode === 'oco' && (
        <div className="grid grid-cols-2 gap-2">
          <Input label="Qty" value={qty} on={setQty} />
          <div />
          <Input label="Take Profit" value={tp} on={setTp} />
          <Input label="Stop Loss" value={sl} on={setSl} />
        </div>
      )}

      {mode === 'bracket' && (
        <div className="grid grid-cols-2 gap-2">
          <Input label="Qty" value={qty} on={setQty} />
          <Input label="進場限價" value={entry} on={setEntry} />
          <Input label="Take Profit" value={tp} on={setTp} />
          <Input label="Stop Loss" value={sl} on={setSl} />
        </div>
      )}

      {mode === 'scaleout' && (
        <>
          {targets.map((t, i) => (
            <div key={i} className="grid grid-cols-[1fr_60px_24px] gap-2 items-end">
              <Input label={`Target ${i + 1} 價`} value={t.price} on={v => {
                const next = [...targets]; next[i] = { ...next[i], price: v }; setTargets(next);
              }} />
              <Input label="qty" value={t.qty} on={v => {
                const next = [...targets]; next[i] = { ...next[i], qty: v }; setTargets(next);
              }} />
              <button
                onClick={() => setTargets(targets.filter((_, j) => j !== i))}
                className="text-rose-400 text-xs py-1"
                disabled={targets.length === 1}
              >×</button>
            </div>
          ))}
          {targets.length < 5 && (
            <button
              onClick={() => setTargets([...targets, { price: '', qty: '1' }])}
              className="text-xs text-amber-300 hover:underline self-start"
            >+ 加一段</button>
          )}
          <Input label="共用 Stop Loss" value={sl} on={setSl} />
          <Input label="Runner trailing (>0 啟用)" value={runnerTrailing} on={setRunnerTrailing} />
        </>
      )}

      <button onClick={submit}
              className="mt-1 bg-amber-500 hover:bg-amber-400 text-slate-900 font-bold py-1.5 rounded text-sm">
        送出 {mode.toUpperCase()}
      </button>
    </div>
  );
};

export default SmartOrderForm;
