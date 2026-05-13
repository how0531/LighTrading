import React, { useEffect, useState } from 'react';
import { getOrderHistory, apiClient, normalizeApiError } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';

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
  if (['PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled'].includes(status)) return `${baseStyle} bg-yellow-500/20 text-yellow-400 border-yellow-500/30`;
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
  const { accountSummary, cancelOrder } = useTradingContext();
  const { toast } = useToast();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [syncAge, setSyncAge] = useState(0); // 距離上次同步的秒數
  // F4: 多選批次刪單
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const tradeKey = (t: Trade) => `${t.time}-${t.symbol}-${t.action}-${t.price}-${t.qty}`;

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const data = await getOrderHistory();
      setTrades(data || []);
      setLastSyncTime(new Date());
    } catch (err) {
      console.error("Failed to fetch order history:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateQty = async (t: Trade) => {
    // 減量 prompt 改用瀏覽器原生 prompt 仍可接受（單行數字輸入，後面想做美化再升級為 Modal）
    const remainingQty = t.qty - t.filled_qty;
    const msg = `輸入新的總委託數量\n原委託 ${t.qty}，已成交 ${t.filled_qty}，最多可減至 ${t.filled_qty}（最少）`;
    const input = window.prompt(msg, remainingQty.toString());
    if (!input) return;

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
      const e = normalizeApiError(err);
      toast.error(e.user_msg || '減量失敗');
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
    ['PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled'].includes(t.status)
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
                const isCancellable = ['PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled'].includes(t.status);
                return (
                <tr key={`${t.time}-${idx}`} className={`hover:bg-white/5 transition-colors ${selected.has(k) ? 'bg-amber-500/10 ring-1 ring-amber-500/30' : 'bg-slate-700/20'}`}>
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
                  <td className="py-2 px-2 font-mono font-medium">{t.symbol}</td>
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
                      <span 
                        className={getBadgeStyle(t.status)}
                        title={['Failed', 'Rejected'].includes(t.status) && t.failed_msg ? `原始原因: ${t.failed_msg}` : undefined}
                      >
                        {formatStatusText(t.status, t.failed_msg)}
                      </span>
                      {['PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled'].includes(t.status) && (
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