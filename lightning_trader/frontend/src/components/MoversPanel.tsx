/**
 * MoversPanel — 盤勢排行 / 市場寬度（Sprint 36）
 *
 * 從自選清單即時報價（TradingContext.watchlistQuotes）算出:
 *   - 頂部市場寬度條:上漲 / 下跌 / 平盤家數 + 紅綠力道條（rankMovers/computeBreadth 純函式）
 *   - 漲幅榜（紅）/ 跌幅榜（綠）左右並排,各取前 N 名
 *
 * 點任一列 → subscribe 切換主商品（與 QuoteBoardPanel 一致）。
 * 與報價看板共用同一份自選清單,不另外管理 symbol。
 */
import React, { useEffect, useMemo } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { useTradingContext } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { formatPrice } from '../utils/instrument';
import { rankMovers, computeBreadth, type MoverInput, type MoverRow } from '../utils/movers';

const TOP_N = 8;

const MoverList: React.FC<{
  title: string;
  rows: MoverRow[];
  up: boolean;
  current: string;
  onPick: (s: string) => void;
}> = ({ title, rows, up, current, onPick }) => {
  const color = up ? 'text-red-400' : 'text-emerald-400';
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${color}`}>
        <Icon className="w-3 h-3" /> {title}
      </div>
      <div className="flex-1 overflow-auto custom-scrollbar">
        {rows.length === 0 ? (
          <div className="py-6 text-center text-slate-600 italic text-[11px]">—</div>
        ) : (
          <table className="w-full text-[11px] tabular-nums">
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.symbol}
                  onClick={() => onPick(r.symbol)}
                  className={`group hover:bg-slate-700/40 cursor-pointer ${r.symbol === current ? 'bg-[#D4AF37]/10 border-l-2 border-[#D4AF37]' : ''}`}
                  title={`點擊切換到 ${r.symbol}`}
                >
                  <td className="px-2 py-0.5 text-left font-mono font-bold text-slate-200 truncate max-w-[70px]">{r.symbol}</td>
                  <td className={`px-2 py-0.5 text-right font-mono ${color}`}>{r.price > 0 ? formatPrice(r.price, r.symbol) : '—'}</td>
                  <td className={`px-2 py-0.5 text-right font-mono ${color}`}>{r.pct > 0 ? '+' : ''}{r.pct.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const MoversPanel: React.FC = () => {
  const { targetSymbol, subscribe, watchlistQuotes, watchSymbols } = useTradingContext();
  const { settings } = useSettings();
  const list = settings.watchlist;

  // 確保獨立彈出視窗（/panel/movers）也會訂閱自選清單；在主儀表板與
  // WatchlistPanel 的呼叫是等冪聯集，不會互相覆蓋或重複送出。
  useEffect(() => {
    watchSymbols(list);
  }, [list, watchSymbols]);

  const inputs: MoverInput[] = useMemo(
    () => list.map((sym) => {
      const q = watchlistQuotes[sym];
      return { symbol: sym, price: q?.price ?? 0, reference: q?.reference ?? 0 };
    }),
    [list, watchlistQuotes],
  );

  const gainers = useMemo(() => rankMovers(inputs, 'gainers', TOP_N), [inputs]);
  const losers = useMemo(() => rankMovers(inputs, 'losers', TOP_N), [inputs]);
  const breadth = useMemo(() => computeBreadth(inputs), [inputs]);
  const upPct = Math.round(breadth.upPct);

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="px-3 py-2 border-b border-slate-700/50 flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <span className="w-1 h-3.5 bg-amber-500 rounded-full"></span>
          盤勢排行
        </h3>
        <span className="text-[10px] font-mono text-slate-500">自選 {list.length}</span>
      </div>

      {/* 市場寬度條 */}
      <div className="px-3 py-1.5 border-b border-slate-700/50 flex items-center gap-2 text-[10px]">
        <span className="font-mono text-red-400 font-bold flex-shrink-0">↑{breadth.up}</span>
        <div className="flex-1 h-2 rounded-full overflow-hidden bg-emerald-500/30 flex" title={`上漲 ${breadth.up} / 下跌 ${breadth.down} / 平盤 ${breadth.flat}`}>
          <div className="h-full bg-red-500/70" style={{ width: `${upPct}%` }} />
        </div>
        <span className="font-mono text-emerald-400 font-bold flex-shrink-0">↓{breadth.down}</span>
        {breadth.flat > 0 && <span className="font-mono text-slate-500 flex-shrink-0">→{breadth.flat}</span>}
      </div>

      <div className="flex-1 min-h-0 flex divide-x divide-slate-700/50">
        <MoverList title="漲幅榜" rows={gainers} up current={targetSymbol} onPick={subscribe} />
        <MoverList title="跌幅榜" rows={losers} up={false} current={targetSymbol} onPick={subscribe} />
      </div>
    </div>
  );
};

export default MoversPanel;
