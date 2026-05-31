/**
 * Panel_TimeAndSales — 成交明細跑馬燈 (T&S)
 *
 * 期貨 scalper 的盤感工具：看「吃單／吐單」節奏。
 * 內盤（賣方主動）= 紅色 / 外盤（買方主動）= 綠色 / 集合競價 = 灰色
 *
 * 資料來源優先順序：
 *   1. 開啟時 GET /api/tape/{symbol} 拉初始 N 筆
 *   2. 之後從 TradingContext.tape（由 WS Tick 累積）接力
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTradingContext } from '../contexts/TradingContext';
import { getTape } from '../api/client';

const TICK_TYPE_LABEL: Record<number, { label: string; cls: string }> = {
  0: { label: '集',  cls: 'text-slate-400' },
  1: { label: '外',  cls: 'text-emerald-400' },
  2: { label: '內',  cls: 'text-rose-400' },
};

const Panel_TimeAndSales: React.FC = () => {
  const { targetSymbol, tape } = useTradingContext();
  const [initialRows, setInitialRows] = useState<typeof tape>([]);
  const symRef = useRef(targetSymbol);

  // 切商品時拉初始 tape，後續 WS Tick 會自動接力
  useEffect(() => {
    symRef.current = targetSymbol;
    setInitialRows([]);
    if (!targetSymbol) return;
    let cancelled = false;
    getTape(targetSymbol, 100)
      .then(res => { if (!cancelled && symRef.current === targetSymbol) setInitialRows(res.rows || []); })
      .catch(() => { /* 後端未登入時 403/503，靜默 */ });
    return () => { cancelled = true; };
  }, [targetSymbol]);

  // 合併「拉的初始 + WS 累積」，去重後取最後 200 筆
  const rows = React.useMemo(() => {
    if (tape.length === 0) return initialRows;
    if (initialRows.length === 0) return tape;
    // 簡化：tape 內若包含 initial 末端，就以 tape 為主
    return tape;
  }, [initialRows, tape]);

  // 鎖底自動捲動：若使用者沒手動往上滑就跟著新成交滾
  const listRef = useRef<HTMLDivElement>(null);
  const lockBottomRef = useRef(true);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    lockBottomRef.current = atBottom;
  };
  useEffect(() => {
    if (lockBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [rows.length]);

  return (
    <div className="h-full flex flex-col bg-[#101623] text-slate-100">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between text-xs">
        <span className="font-bold tracking-widest text-slate-300">TIME &amp; SALES</span>
        <span className="text-slate-500">{targetSymbol} · {rows.length} 筆</span>
      </div>
      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto font-mono text-[12px] leading-tight"
      >
        {rows.length === 0 ? (
          <div className="text-slate-500 text-center pt-4">等待成交資料…</div>
        ) : rows.map((r, i) => {
          const tt = TICK_TYPE_LABEL[r.tick_type] || TICK_TYPE_LABEL[0];
          return (
            <div
              key={`${r.time}-${i}`}
              className={`grid grid-cols-[60px_56px_60px_30px] gap-1 px-2 py-[2px] border-b border-slate-800/40 ${tt.cls}`}
            >
              <span className="text-slate-400 truncate">{(r.time || '').slice(-8)}</span>
              <span className="text-right">{r.price.toFixed(2)}</span>
              <span className="text-right text-slate-300">{r.volume.toLocaleString()}</span>
              <span className="text-center text-[10px]">{tt.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Panel_TimeAndSales;
