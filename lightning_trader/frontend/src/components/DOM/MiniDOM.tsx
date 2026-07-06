/**
 * MiniDOM — ⚡全開宮格裡的單一商品迷你五檔 ladder（Sprint D）
 *
 * 資料源（皆為 100ms dirty-set flush，只有變動的 symbol 換物件參照）：
 *   - book：TradingContext.bidAskBySymbol（背景訂閱的完整五檔）
 *   - quote：TradingContext.watchlistQuotes（現價 / 參考價 → computeChange 口徑漲跌%）
 *
 * ladder 語彙沿用主 DOM：買紅 / 賣綠、量能條、每列左=買側點擊掛買 LMT、
 * 右=賣側點擊掛賣 LMT（該列價格）。下單流程由父層（MultiDOMGrid 的
 * useMiniDomOrder）注入 onPlace，元件本身純渲染 + React.memo 隔離。
 */
import React, { useMemo } from 'react';
import { Crosshair } from 'lucide-react';
import { formatPrice } from '../../utils/instrument';
import { computeChange } from '../../utils/quoteBoard';
import type { BidAskData } from '../../types';
import type { MiniQuote } from '../../contexts/TradingContext';

interface LadderRow {
  price: number;
  vol: number;
  side: 'bid' | 'ask';
}

export interface MiniDOMProps {
  symbol: string;
  quote: MiniQuote | undefined;
  book: BidAskData | undefined;
  isTarget: boolean;
  /** 該商品目前未成交委託筆數（workingOrders 過濾） */
  workingCount: number;
  /** 宮格開啟期間被移出自選 → 灰態鎖定（背景訂閱已退訂，資料不再更新） */
  removed: boolean;
  /** P2：報價凍結（斷線 / 盤後無 tick / 該商品逾時未更新）→ 視覺標示，下單走 danger 確認 */
  stale?: boolean;
  onPlace: (symbol: string, price: number, action: 'Buy' | 'Sell') => void;
  onSetPrimary: (symbol: string) => void;
}

const MiniDOMInner: React.FC<MiniDOMProps> = ({
  symbol, quote, book, isTarget, workingCount, removed, stale = false, onPlace, onSetPrimary,
}) => {
  // 5+5 檔：賣五…賣一（上）＋ 買一…買五（下）；同時算量能條分母
  const { rows, maxVol } = useMemo(() => {
    const bp = book?.BidPrice ?? [];
    const bv = book?.BidVolume ?? [];
    const ap = book?.AskPrice ?? [];
    const av = book?.AskVolume ?? [];
    const out: LadderRow[] = [];
    for (let i = Math.min(ap.length, 5) - 1; i >= 0; i--) {
      if (ap[i] > 0) out.push({ price: ap[i], vol: av[i] || 0, side: 'ask' });
    }
    for (let i = 0; i < Math.min(bp.length, 5); i++) {
      if (bp[i] > 0) out.push({ price: bp[i], vol: bv[i] || 0, side: 'bid' });
    }
    let m = 1;
    for (const r of out) if (r.vol > m) m = r.vol;
    return { rows: out, maxVol: m };
  }, [book]);

  const price = quote?.price ?? 0;
  const change = computeChange(price, quote?.reference ?? 0);
  const changeCls = !change || change.change === 0
    ? 'text-slate-400'
    : change.change > 0 ? 'text-red-400' : 'text-emerald-400';
  const sign = change && change.change > 0 ? '+' : '';

  return (
    <div className={`relative flex flex-col min-h-0 rounded-lg border overflow-hidden bg-[#101623] ${
      isTarget ? 'border-[#D4AF37]/70 shadow-[0_0_10px_rgba(212,175,55,0.15)]' : 'border-slate-700/70'
    }`} data-testid={`minidom-${symbol}`}>
      {/* Header：代碼 / 現價 / 漲跌% / 掛單徽章 / 設為主商品 */}
      <div className="shrink-0 px-2 py-1.5 bg-[#1c2331] border-b border-slate-800 flex items-center gap-2">
        <span className={`font-mono font-black text-[12px] ${isTarget ? 'text-[#D4AF37]' : 'text-slate-200'}`}>
          {symbol}
        </span>
        {workingCount > 0 && (
          <span
            className="px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] font-black leading-none tabular-nums"
            title={`${workingCount} 筆未成交委託`}
            data-testid={`minidom-working-${symbol}`}
          >
            掛 {workingCount}
          </span>
        )}
        {stale && (
          <span
            className="px-1 py-0.5 rounded bg-slate-500/25 text-slate-300 border border-slate-400/40 text-[9px] font-black leading-none animate-pulse"
            title="報價已停止更新（可能斷線／盤後）—— 下單將需二次確認"
            data-testid={`minidom-stale-${symbol}`}
          >
            凍結
          </span>
        )}
        <div className="ml-auto flex items-baseline gap-1.5 font-mono tabular-nums leading-none">
          <span className={`text-[13px] font-black ${changeCls}`}>
            {price > 0 ? formatPrice(price, symbol) : '—'}
          </span>
          <span className={`text-[10px] font-bold ${changeCls}`}>
            {change ? `${sign}${change.pct.toFixed(2)}%` : '—'}
          </span>
        </div>
        <button
          onClick={() => onSetPrimary(symbol)}
          className="p-1 rounded border border-slate-700 bg-slate-800/70 text-slate-400 hover:text-[#D4AF37] hover:border-[#D4AF37]/60 transition-colors cursor-pointer"
          title={`設為主商品（主 DOM 切到 ${symbol}）`}
          data-testid={`minidom-primary-${symbol}`}
        >
          <Crosshair className="w-3 h-3" />
        </button>
      </div>

      {/* 迷你 ladder：買側（左，紅）｜價格｜賣側（右，綠）；stale 時降透明度標示凍結 */}
      <div className={`flex-1 min-h-0 overflow-auto custom-scrollbar text-[11px] font-mono tabular-nums select-none transition-opacity ${stale ? 'opacity-50' : ''}`}>
        {rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-600 text-[10px] animate-pulse py-6">
            等待五檔報價…
          </div>
        ) : (
          <table className="w-full border-collapse table-fixed text-center">
            <tbody>
              {rows.map((r) => {
                const width = Math.min((r.vol / maxVol) * 100, 100);
                const isBid = r.side === 'bid';
                // 價格字色沿用台股紅漲綠跌（相對參考價），與主 DOM 價格欄一致
                const ref = quote?.reference ?? 0;
                const priceCls = ref > 0
                  ? (r.price > ref ? 'text-red-400' : r.price < ref ? 'text-emerald-400' : 'text-slate-300')
                  : 'text-slate-300';
                return (
                  <tr key={`${r.side}-${r.price}`} className="h-6 border-b border-slate-800/60">
                    {/* 買側：點擊該價掛買 LMT */}
                    <td
                      className="relative w-[34%] bg-red-950/25 text-red-400 font-bold cursor-pointer hover:bg-red-900/50 border-r border-slate-800 overflow-hidden transition-colors"
                      onClick={() => onPlace(symbol, r.price, 'Buy')}
                      title={`買進 ${symbol} @ ${formatPrice(r.price, symbol)}`}
                      data-testid={`minidom-buy-${symbol}-${Math.round(r.price * 100)}`}
                    >
                      {isBid && (
                        <>
                          <div
                            className="absolute inset-y-0.5 right-0 bg-gradient-to-l from-red-600/10 to-red-600/40"
                            style={{ width: `${width}%` }}
                          />
                          <span className="relative z-10">{r.vol || ''}</span>
                        </>
                      )}
                    </td>
                    {/* 價格欄：紅漲綠跌（相對參考價），與主 DOM 一致 */}
                    <td className={`w-[32%] font-black border-r border-slate-800 bg-slate-900/40 ${priceCls}`}>
                      {formatPrice(r.price, symbol)}
                    </td>
                    {/* 賣側：點擊該價掛賣 LMT */}
                    <td
                      className="relative w-[34%] bg-emerald-950/25 text-emerald-400 font-bold cursor-pointer hover:bg-emerald-900/50 overflow-hidden transition-colors"
                      onClick={() => onPlace(symbol, r.price, 'Sell')}
                      title={`賣出 ${symbol} @ ${formatPrice(r.price, symbol)}`}
                      data-testid={`minidom-sell-${symbol}-${Math.round(r.price * 100)}`}
                    >
                      {!isBid && (
                        <>
                          <div
                            className="absolute inset-y-0.5 left-0 bg-gradient-to-r from-emerald-600/10 to-emerald-600/40"
                            style={{ width: `${width}%` }}
                          />
                          <span className="relative z-10">{r.vol || ''}</span>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 已移出自選：灰態鎖定（背景訂閱已退訂，殘留資料不可再交易） */}
      {removed && (
        <div
          className="absolute inset-0 z-10 bg-[#0b101b]/85 backdrop-blur-[1px] flex flex-col items-center justify-center gap-1"
          data-testid={`minidom-removed-${symbol}`}
        >
          <span className="text-slate-400 text-xs font-black tracking-widest">已移除</span>
          <span className="text-slate-600 text-[10px]">{symbol} 已不在自選清單</span>
        </div>
      )}
    </div>
  );
};

// 宮格 9 檔全開時，只有 dirty symbol 的 quote/book 參照會換 → memo 擋掉其餘格子重繪
export const MiniDOM = React.memo(MiniDOMInner);
MiniDOM.displayName = 'MiniDOM';
