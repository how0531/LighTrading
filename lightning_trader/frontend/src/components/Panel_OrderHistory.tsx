import React, { useEffect, useState } from 'react';
import { getOrderHistory, apiClient } from '../api/client';
import { useTradingCore } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { useApiErrorToast } from '../hooks/useApiErrorToast';
import { isActiveOrderStatus } from '../utils/orderStatus';

interface Trade {
  time: string;
  symbol: string;
  action: 'Buy' | 'Sell';
  price: number;
  qty: number;
  status: string;
  filled_qty: number;
  filled_avg_price: number;
  failed_msg?: string;
}

const translateFailedMsg = (msg: string | undefined): string => {
  if (!msg) return '系統退單';
  const lowerMsg = msg.toLowerCase();
  if (lowerMsg.includes('margin') || lowerMsg.includes('balance') || lowerMsg.includes('insufficient')) return '餘額不足';
  if (lowerMsg.includes('inventory') || lowerMsg.includes('position')) return '庫存錯誤';
  if (lowerMsg.includes('range') || lowerMsg.includes('price error')) return '價格限制';
  if (lowerMsg.includes('session') || lowerMsg.includes('time')) return '非交易時間';
  if (lowerMsg.includes('day trade') || lowerMsg.includes('control limit')) return '額度受限';
  if (lowerMsg.includes('not supported') || lowerMsg.includes('invalid')) return '條件錯誤';
  return '系統退單';
};

const getBadgeStyle = (status: string) => {
  const baseStyle = "border rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap";
  if (status === 'Filled') return `${baseStyle} bg-slate-600/30 text-slate-300 border-slate-600/50`;
  if (status === 'Cancelled') return `${baseStyle} bg-slate-500/10 text-slate-500 border-slate-500/20`;
  if (isActiveOrderStatus(status)) return `${baseStyle} bg-yellow-500/20 text-yellow-400 border-yellow-500/30`;
  if (['Failed', 'Rejected'].includes(status)) return `${baseStyle} bg-red-500/20 text-red-400 border-red-500/30`;
  return `${baseStyle} bg-slate-500/20 text-slate-400 border-slate-500/30`;
};

const formatStatusText = (status: string, failedMsg?: string): string => {
  if (status === 'Filled') return '已成交';
  if (status === 'Cancelled') return '已刪單';
  if (['PendingSubmit', 'PreSubmitted', 'Submitted'].includes(status)) return '委託中';
  if (status === 'PartFilled') return '部分成交';
  if (['Failed', 'Rejected'].includes(status)) return translateFailedMsg(failedMsg);
  return status;
};

const Panel_OrderHistory: React.FC = () => {
  const { accountSummary, cancelOrder, isConnected } = useTradingCore();
  const { toast } = useToast();
  const { confirmWithInput } = useConfirm();
  const handleApiError = useApiErrorToast();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [syncAge, setSyncAge] = useState(0); // 距離上次同步的秒數
  // F4: 多選批次刪單
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const tradeKey = (t: Trade) => `${t.time}-${t.symbol}-${t.action}-${t.price}-${t.qty}`;

  // 取得商品中文名稱快取
  const [namesCache, setNamesCache] = useState<Record<string, string>>({});
  const fetchingRef = React.useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isConnected) {
      fetchingRef.current.clear();
      return;
    }
    const symbols = trades.map(t => t.symbol);
    const missing = symbols.filter(sym => sym && !namesCache[sym] && !fetchingRef.current.has(sym));
    if (missing.length === 0) return;

    missing.forEach(sym => fetchingRef.current.add(sym));

    missing.forEach(sym => {
      apiClient.get('/symbols/search', { params: { q: sym, limit: 5 } })
        .then(res => {
          const hits = res.data || [];
          const hit = hits.find((h: { symbol: string; name?: string }) => h.symbol === sym);
          if (hit && hit.name) {
            setNamesCache(prev => ({ ...prev, [sym]: hit.name }));
          } else {
            const cleanSym = sym.replace(/^(TSE|OTC)/i, '');
            if (cleanSym !== sym) {
              apiClient.get('/symbols/search', { params: { q: cleanSym, limit: 5 } })
                .then(res2 => {
                  const hits2 = res2.data || [];
                  const hit2 = hits2.find((h: { symbol: string; name?: string }) => h.symbol === cleanSym);
                  if (hit2 && hit2.name) {
                    setNamesCache(prev => ({ ...prev, [sym]: hit2.name }));
                  } else {
                    fetchingRef.current.delete(sym);
                  }
                })
                .catch(() => {
                  fetchingRef.current.delete(sym);
                });
            } else {
              fetchingRef.current.delete(sym);
            }
          }
        })
        .catch(() => {
          fetchingRef.current.delete(sym);
        });
    });
  }, [trades, namesCache, isConnected]);

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const data: Trade[] | { orders?: Trade[] } = await getOrderHistory();
      const historyTrades = Array.isArray(data) ? data : (data?.orders || []);
      setTrades(historyTrades);
      setLastSyncTime(new Date());
    } catch (err) {
      console.error("Failed to fetch order history:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateQty = async (t: Trade) => {
    // 減量改用 ConfirmDialog 的輸入模式（UX 批次 3，取代 window.prompt）
    const remainingQty = t.qty - t.filled_qty;
    const input = await confirmWithInput({
      title: '委託減量',
      message: `輸入新的總委託數量\n原委託 ${t.qty}，已成交 ${t.filled_qty}，最多可減至 ${t.filled_qty}（最少）`,
      defaultValue: remainingQty.toString(),
      confirmLabel: '確認減量',
      validate: (v) => {
        const trimmed = v.trim();
        const n = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
        if (isNaN(n) || n >= t.qty || n < t.filled_qty) {
          return `輸入無效：必須 ≥ ${t.filled_qty} 且 < ${t.qty}`;
        }
        return null;
      },
    });
    if (input == null) return;

    const newQty = parseInt(input, 10);
    if (isNaN(newQty) || newQty >= t.qty || newQty < t.filled_qty) {
      toast.error(`輸入無效：必須 ≥ ${t.filled_qty} 且 < ${t.qty}`);
      return;
    }

    try {
      await apiClient.post('/update_order', {
        symbol: t.symbol,
        action: t.action,
        old_price: t.price,
        new_price: t.price,
        qty: newQty
      });
      toast.success(`${t.symbol} 減量至 ${newQty}`);
      setTimeout(fetchHistory, 500);
    } catch (err) {
      handleApiError(err, '減量失敗');
    }
  };

  // 每秒更新同步年齡（距離上次同步的秒數）
  useEffect(() => {
    const timer = setInterval(() => {
      if (lastSyncTime) {
        setSyncAge(Math.floor((Date.now() - lastSyncTime.getTime()) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lastSyncTime]);

  // 使用 msg_count 作為 dependency，避免每個 tick 都觸發 HTTP 請求
  const accountMsgCount = accountSummary.msg_count;
  useEffect(() => {
    fetchHistory();
  }, [accountMsgCount]);

  const validTrades = trades.filter(t => t.symbol && t.symbol.trim() !== "");
  const cancellable = validTrades.filter(t =>
    isActiveOrderStatus(t.status)
  );

  const toggleSelected = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllCancellable = () => {
    if (selected.size === cancellable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(cancellable.map(tradeKey)));
    }
  };

  const batchCancel = () => {
    const targets = cancellable.filter((t) => selected.has(tradeKey(t)));
    if (targets.length === 0) return;
    toast.warn(`將批次刪除 ${targets.length} 筆委託`, {
      actionLabel: '確認批次刪單',
      durationMs: 8000,
      onAction: async () => {
        for (const t of targets) {
          try { await cancelOrder(t.action, t.price); } catch { /* 個別失敗繼續 */ }
        }
        setSelected(new Set());
        toast.info(`批次刪單已送出 ${targets.length} 筆`);
        setTimeout(fetchHistory, 500);
      },
    });
  };

  return (
    <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">今日委託 (Order History)</h3>
          {lastSyncTime && (
            <span className={`text-[9px] font-mono tabular-nums ${syncAge > 5 ? 'text-yellow-400' : 'text-slate-500'}`}>
              {syncAge > 5 && '⚠️ '}{lastSyncTime.toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {selected.size > 0 && (
            <button
              onClick={batchCancel}
              className="text-xs bg-red-600/30 hover:bg-red-600/50 text-red-200 border border-red-600/50 px-2 py-1 rounded transition-colors font-bold"
              title="批次刪除已選取的委託"
            >
              刪除選取 ({selected.size})
            </button>
          )}
          <button
            onClick={fetchHistory}
            className="text-xs bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded transition-colors"
          >
            重新整理
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto relative custom-scrollbar">
        {isLoading && (
          <div className="absolute inset-0 bg-slate-900/50 flex items-center justify-center z-10">
            <span className="text-slate-400 text-sm">Loading...</span>
          </div>
        )}
        <table className="w-full text-xs text-left border-separate border-spacing-y-1">
          <thead className="sticky top-0 bg-slate-800 text-slate-500 z-10">
            <tr>
              <th className="pb-2 px-2 w-6">
                {cancellable.length > 0 && (
                  <input
                    type="checkbox"
                    checked={selected.size === cancellable.length && cancellable.length > 0}
                    onChange={selectAllCancellable}
                    className="accent-[#D4AF37] cursor-pointer"
                    title="全選/取消全選 可刪委託"
                  />
                )}
              </th>
              <th className="pb-2 font-medium px-2">時間</th>
              <th className="pb-2 font-medium px-2">商品</th>
              <th className="pb-2 font-medium px-2">方向</th>
              <th className="pb-2 font-medium text-right px-2">委託價/量</th>
              <th className="pb-2 font-medium text-right px-2">成交均價/量</th>
              <th className="pb-2 font-medium text-right px-2">狀態</th>
            </tr>
          </thead>
          <tbody>
            {validTrades.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-500">今日尚無委託</td>
              </tr>
            ) : (
              validTrades.map((t, idx) => {
                const k = tradeKey(t);
                const isCancellable = isActiveOrderStatus(t.status);
                // UX 批次 4 Item 5：部分成交（活躍單已成交部分數量）→ 琥珀色列標記 + 進度徽章
                const isPartialFill = isCancellable && t.filled_qty > 0 && t.filled_qty < t.qty;
                return (
                <tr key={`${t.time}-${idx}`} className={`hover:bg-white/5 transition-colors ${selected.has(k) ? 'bg-amber-500/10 ring-1 ring-amber-500/30' : isPartialFill ? 'bg-amber-500/5 border-l-2 border-amber-400/70' : 'bg-slate-700/20'}`}>
                  <td className="py-2 px-2">
                    {isCancellable && (
                      <input
                        type="checkbox"
                        checked={selected.has(k)}
                        onChange={() => toggleSelected(k)}
                        className="accent-[#D4AF37] cursor-pointer"
                      />
                    )}
                  </td>
                  <td className="py-2 px-2 text-slate-400 font-mono tabular-nums">{t.time.split('T')[1]?.split('.')[0] || t.time}</td>
                  <td className="py-2 px-2 font-mono font-medium">
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-sans font-bold text-slate-200 leading-tight">
                        {namesCache[t.symbol] || t.symbol.replace(/^(TSE|OTC)/i, '')}
                      </span>
                      {namesCache[t.symbol] && (
                        <span className="text-[9px] text-slate-500 font-mono font-normal max-w-[80px] truncate leading-tight" title={t.symbol}>
                          {t.symbol.replace(/^(TSE|OTC)/i, '')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={`py-2 px-2 font-bold ${t.action === 'Buy' ? 'text-red-400' : 'text-green-400'}`}>
                    {t.action === 'Buy' ? '買' : '賣'}
                  </td>
                  <td className="py-2 px-2 text-right font-mono tabular-nums">
                    {t.price === 0 ? '市價' : t.price.toFixed(2)} / {t.qty}
                  </td>
                  <td className="py-2 px-2 text-right font-mono tabular-nums">
                    {t.filled_qty > 0 ? t.filled_avg_price.toFixed(2) : '-'} / {t.filled_qty}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isPartialFill && (
                        <span
                          className="border rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap font-mono tabular-nums bg-amber-500/20 text-amber-300 border-amber-500/40 font-bold"
                          title={`部分成交：已成交 ${t.filled_qty} / 委託 ${t.qty}`}
                        >
                          {t.filled_qty}/{t.qty}
                        </span>
                      )}
                      <span
                        className={getBadgeStyle(t.status)}
                        title={['Failed', 'Rejected'].includes(t.status) && t.failed_msg ? `原始原因: ${t.failed_msg}` : undefined}
                      >
                        {formatStatusText(t.status, t.failed_msg)}
                      </span>
                      {isActiveOrderStatus(t.status) && (
                        <>
                          <button
                            onClick={() => handleUpdateQty(t)}
                            className="bg-slate-700 hover:bg-blue-500 hover:text-white text-slate-300 rounded px-2 py-0.5 text-[10px] transition-colors shadow-sm"
                          >
                            減量
                          </button>
                          <button
                            onClick={() => {
                              toast.warn(`刪除 ${t.symbol} ${t.action === 'Buy' ? '買' : '賣'} @${t.price}？`, {
                                actionLabel: '確認刪單',
                                durationMs: 6000,
                                onAction: () => cancelOrder(t.action, t.price),
                              });
                            }}
                            className="bg-slate-700 hover:bg-red-500 hover:text-white text-slate-300 rounded px-2 py-0.5 text-[10px] transition-colors shadow-sm"
                          >
                            刪單
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Panel_OrderHistory;