import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { getPositions, getAccounts, apiClient } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';
import {
  firstEntryTs,
  entryFillCount,
  formatHolding,
  nearestStopTrigger,
  distanceToStop,
  type FillLite,
} from '../utils/positionContext';

interface Position {
  symbol: string;
  qty: number;
  direction: 'Buy' | 'Sell';
  price: number;
  pnl: number;
}

interface Account {
  account_id: string;
  category: string;
  account_name: string;
}

const Panel_Positions: React.FC = () => {
  const { isConnected, accountSummary, subscribe, flattenPosition, realtimePositions, totalRealtimePnl, smartOrders, watchlistQuotes } = useTradingContext();
  const { toast } = useToast();
  const [positions, setPositions] = useState<Position[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | 'Stock' | 'Future' | 'Option'>('ALL');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  // Sprint 30：持倉脈絡 — 展開列顯示該 symbol 的 fills 明細
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fillsCache, setFillsCache] = useState<Record<string, FillLite[]>>({});
  const [fillsLoading, setFillsLoading] = useState<string | null>(null);

  const loadFills = useCallback(async (symbol: string) => {
    if (fillsCache[symbol]) return;
    setFillsLoading(symbol);
    try {
      const res = await apiClient.get<FillLite[]>('/journal/fills', { params: { symbol, limit: 100 } });
      setFillsCache((prev) => ({ ...prev, [symbol]: res.data || [] }));
    } catch {
      setFillsCache((prev) => ({ ...prev, [symbol]: [] }));
    } finally {
      setFillsLoading(null);
    }
  }, [fillsCache]);

  const toggleExpand = useCallback((symbol: string) => {
    setExpanded((prev) => {
      const next = prev === symbol ? null : symbol;
      if (next) loadFills(next);
      return next;
    });
  }, [loadFills]);

  const fetchAccounts = async () => {
    try {
      const data = await getAccounts();
      setAccounts(data || []);

      // 如果還沒選帳號，且現在有帳號了，預設選第一個
      if (!selectedAccountId && data && data.length > 0) {
        // 考慮到類別篩選，這裡暫不預設避免混亂，讓使用者手動選
      }
    } catch (err) {
      console.error("Failed to fetch accounts:", err);
    }
  };

  const fetchPositions = async (accountId?: string) => {
    setIsLoading(true);
    try {
      const data = await getPositions(accountId);
      setPositions(data || []);
    } catch (err) {
      console.error("Failed to fetch positions:", err);
    } finally {
      setIsLoading(false);
    }
  };

  // 1. 初次掛載與連機狀態變動時，更新帳號列表
  useEffect(() => {
    fetchAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  // 2. 當選擇的帳號改變或 WebSocket 有帳務摘要更新時，更新持倉
  // 使用 msg_count 作為 dependency，避免每個 tick 都觸發 HTTP 請求
  const accountMsgCount = accountSummary.msg_count;
  useEffect(() => {
    fetchPositions(selectedAccountId || undefined);
  }, [selectedAccountId, accountMsgCount]);

  // 過濾後的帳號清單
  const filteredAccounts = useMemo(() => {
    if (selectedCategory === 'ALL') return accounts;
    const target = selectedCategory.toLowerCase();
    return accounts.filter(acc => {
      if (!acc.category) return false;
      const cat = acc.category.toLowerCase();
      // Stock / Future / Option 三類獨立比對
      return cat.startsWith(target);
    });
  }, [accounts, selectedCategory]);

  // 當類別改變時，如果目前的 selectedAccountId 不在 filtered 內，清空它 (或者如果類別變更，先重設)
  useEffect(() => {
    if (selectedAccountId && !filteredAccounts.find(a => a.account_id === selectedAccountId)) {
      setSelectedAccountId('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, filteredAccounts]);

  return (
    <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700 h-full flex flex-col glass-panel shadow-2xl relative">
      <div className="flex flex-col gap-2.5 mb-3">
        <div className="flex justify-between items-center">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <span className="w-1 h-3.5 bg-amber-500 rounded-full"></span>
            即時持倉 (Positions)
          </h3>
          <button
            onClick={() => fetchPositions(selectedAccountId)}
            className="text-[10px] bg-slate-700/50 hover:bg-slate-600 px-2 py-0.5 rounded transition-all text-slate-400 border border-slate-600"
          >
            重新整理
          </button>
        </div>

        {/* 控制列：類別與帳號選單 */}
        <div className="flex items-center gap-2">
          {/* 類別切換 (樣式模仿截圖) */}
          <div className="flex gap-1">
            {([
              { id: 'ALL',    label: '全' },
              { id: 'Stock',  label: '證' },
              { id: 'Future', label: '期' },
              { id: 'Option', label: '權' },
            ] as const).map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`w-7 h-7 flex items-center justify-center text-xs font-bold rounded-sm border transition-all ${selectedCategory === cat.id
                  ? 'bg-amber-400 text-slate-900 border-amber-500 shadow-[0_0_10px_rgba(251,191,36,0.2)]'
                  : 'bg-slate-800 text-slate-500 border-slate-700 hover:border-slate-500'
                  }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* 帳號選單 */}
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="flex-1 bg-slate-900/90 border border-slate-700 text-slate-200 text-[11px] font-medium py-1 px-2 rounded outline-none focus:border-amber-500/50 transition-colors h-7 shadow-inner"
          >
            <option value="">所有帳號</option>
            {filteredAccounts.map(acc => (
              <option key={acc.account_id} value={acc.account_id}>
                {acc.account_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full text-[11px] text-left border-separate border-spacing-y-1">
          <thead className="sticky top-0 bg-[#1C2331] text-slate-500 z-10">
            <tr>
              <th className="px-1 py-2 font-medium border-b border-slate-700/50 w-5"></th>
              <th className="px-2 py-2 font-medium border-b border-slate-700/50">代碼</th>
              <th className="px-2 py-2 font-medium border-b border-slate-700/50">方向</th>
              <th className="px-2 py-2 font-medium text-right border-b border-slate-700/50">數量</th>
              <th className="px-2 py-2 font-medium text-right border-b border-slate-700/50">均價</th>
              <th className="px-2 py-2 font-medium text-right border-b border-slate-700/50">即時損益</th>
              <th className="px-2 py-2 font-medium text-right border-b border-slate-700/50">持有</th>
              <th className="px-2 py-2 font-medium text-right border-b border-slate-700/50">距停損</th>
              <th className="px-2 py-2 font-medium text-center border-b border-slate-700/50 w-12">操作</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-slate-600 font-medium tracking-widest italic">尚無部位</td>
              </tr>
            ) : (
              positions.map((pos, idx) => {
                // 查找即時損益：優先使用 realtimePositions 中的即時 PnL
                const rtPos = realtimePositions.find(rp => rp.symbol === pos.symbol);
                const displayPnl = rtPos ? rtPos.realtimePnl : pos.pnl;
                const fills = fillsCache[pos.symbol] || [];
                const entryTs = firstEntryTs(fills, pos.direction);
                const holdMs = entryTs > 0 ? Date.now() - entryTs : 0;
                const addCount = entryFillCount(fills, pos.direction);
                const curPrice = rtPos?.currentPrice || watchlistQuotes[pos.symbol]?.price || 0;
                const stopTrigger = nearestStopTrigger(smartOrders, pos.symbol, pos.direction);
                const stop = distanceToStop(curPrice, pos.direction, stopTrigger);
                const isOpen = expanded === pos.symbol;
                return (
                <React.Fragment key={`${pos.symbol}-${idx}`}>
                <tr
                  className={`transition-colors ${displayPnl > 0 ? 'bg-red-500/10 hover:bg-red-500/20' :
                      displayPnl < 0 ? 'bg-green-500/10 hover:bg-green-500/20' :
                        'bg-slate-700/20 hover:bg-slate-700/40'
                    }`}
                >
                  <td className="px-1 py-2 text-center cursor-pointer text-slate-500 hover:text-[#D4AF37]"
                      onClick={() => toggleExpand(pos.symbol)}
                      title="展開進場明細">
                    {isOpen ? <ChevronDown className="w-3.5 h-3.5 inline" /> : <ChevronRight className="w-3.5 h-3.5 inline" />}
                  </td>
                  <td
                    className="px-2 py-2 font-mono tabular-nums text-slate-200 cursor-pointer hover:text-[#D4AF37] hover:underline transition-colors"
                    onClick={() => {
                      subscribe(pos.symbol);
                      toast.info(`已切換至 ${pos.symbol}`);
                    }}
                    title={`點擊切換至 ${pos.symbol}`}
                  >{pos.symbol}</td>
                  <td className={`px-2 py-2 font-extrabold ${pos.direction === 'Buy' ? 'text-red-500' : 'text-green-500'}`}>
                    <span className={`inline-block px-1 rounded ${pos.direction === 'Buy' ? 'bg-red-500/10' : 'bg-green-500/10'}`}>
                      {pos.direction === 'Buy' ? '多' : '空'}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-300">
                    {pos.qty}{addCount > 1 && <span className="text-[9px] text-slate-500 ml-0.5">/{addCount}筆</span>}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-400">{pos.price.toLocaleString()}</td>
                  <td className={`px-2 py-2 text-right font-mono tabular-nums font-bold ${displayPnl >= 0 ? 'text-red-500 shadow-red-500/10' : 'text-green-500 shadow-green-500/10'}`}>
                    <span className={displayPnl !== 0 ? 'drop-shadow-[0_0_8px_rgba(0,0,0,0.5)]' : ''}>
                      {displayPnl > 0 ? '+' : ''}{displayPnl.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-400" title={entryTs > 0 ? new Date(entryTs).toLocaleString() : '無進場紀錄'}>
                    {formatHolding(holdMs)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">
                    {stop ? (
                      <span className={stop.pct >= 0 ? 'text-slate-300' : 'text-red-500 font-bold'}>
                        {stop.pct >= 0 ? '' : '⚠ '}{stop.pct.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toast.warn(
                          `將以市價平倉 ${pos.symbol}（${pos.direction === 'Buy' ? '多' : '空'} ${pos.qty} 口/張）`,
                          {
                            actionLabel: '確認平倉',
                            durationMs: 8000,
                            onAction: () => {
                              flattenPosition(pos.symbol);
                              toast.info(`${pos.symbol} 平倉指令已送出`);
                            },
                          }
                        );
                      }}
                      className="bg-slate-700 hover:bg-amber-500 hover:text-black text-slate-300 rounded px-2 py-0.5 text-[10px] font-bold transition-all shadow-sm"
                    >
                      平倉
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={9} className="px-3 py-2 bg-slate-900/40">
                      {fillsLoading === pos.symbol ? (
                        <div className="text-[10px] text-slate-500 italic py-1">載入進場明細…</div>
                      ) : fills.length === 0 ? (
                        <div className="text-[10px] text-slate-600 italic py-1">此商品無歷史成交紀錄（journal 未落地或未匯入）</div>
                      ) : (
                        <div className="space-y-0.5">
                          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">
                            進場明細（最近 {Math.min(fills.length, 100)} 筆）
                          </div>
                          <table className="w-full text-[10px] font-mono tabular-nums">
                            <tbody>
                              {fills.slice(0, 20).map((f, fi) => (
                                <tr key={fi} className="text-slate-400">
                                  <td className="py-0.5 text-slate-500">{new Date(f.ts).toLocaleString()}</td>
                                  <td className={`py-0.5 ${f.action === 'Buy' ? 'text-red-400' : 'text-green-400'}`}>
                                    {f.action === 'Buy' ? '買' : '賣'}
                                  </td>
                                  <td className="py-0.5 text-right text-slate-300">{f.price.toLocaleString()}</td>
                                  <td className="py-0.5 text-right">{f.qty}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 即時總損益匯總 */}
      {positions.length > 0 && (
        <div className={`px-3 py-2 mt-1 rounded border flex justify-between items-center text-[11px] font-mono tabular-nums ${totalRealtimePnl >= 0 ? 'border-red-800/40 bg-red-950/20' : 'border-emerald-800/40 bg-emerald-950/20'}`}>
          <span className="text-slate-400 font-bold">即時總損益</span>
          <span className={`font-black text-sm ${totalRealtimePnl >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {totalRealtimePnl > 0 ? '+' : ''}{totalRealtimePnl.toLocaleString()}
          </span>
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1px] flex items-center justify-center rounded-lg pointer-events-none">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
    </div>
  );
};

export default Panel_Positions;