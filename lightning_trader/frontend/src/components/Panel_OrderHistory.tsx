import React, { useEffect, useState } from 'react';
import { getOrderHistory } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';

interface Trade {
  time: string;
  symbol: string;
  action: 'Buy' | 'Sell';
  price: number;
  qty: number;
  status: string;
  filled_qty: number;
  filled_avg_price: number;
}

const getBadgeStyle = (status: string) => {
  const baseStyle = "border rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap";
  if (status === 'Filled') return `${baseStyle} bg-green-500/20 text-green-400 border-green-500/30`;
  if (status === 'Cancelled') return `${baseStyle} bg-slate-500/20 text-slate-400 border-slate-500/30`;
  if (['PendingSubmit', 'PreSubmitted', 'Submitted'].includes(status)) return `${baseStyle} bg-yellow-500/20 text-yellow-400 border-yellow-500/30`;
  if (['Failed', 'Rejected'].includes(status)) return `${baseStyle} bg-red-500/20 text-red-400 border-red-500/30`;
  return `${baseStyle} bg-slate-500/20 text-slate-100 border-slate-500/30`;
};

const Panel_OrderHistory: React.FC = () => {
  const { accountSummary, cancelOrder } = useTradingContext();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [syncAge, setSyncAge] = useState(0); // 距離上次同步的秒數

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
        <button
          onClick={fetchHistory}
          className="text-xs bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded transition-colors"
        >
          重新整理
        </button>
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
                <td colSpan={6} className="py-8 text-center text-slate-500">今日尚無委託</td>
              </tr>
            ) : (
              validTrades.map((t, idx) => (
                <tr key={`${t.time}-${idx}`} className="hover:bg-white/5 transition-colors bg-slate-700/20">
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
                      <span className={getBadgeStyle(t.status)}>{t.status}</span>
                      {['PendingSubmit', 'PreSubmitted', 'Submitted'].includes(t.status) && (
                        <button
                          onClick={() => {
                            if (window.confirm(`確定要取消 ${t.symbol} 委託單嗎？`)) {
                              cancelOrder(t.action, t.price);
                            }
                          }}
                          className="bg-slate-700 hover:bg-red-500 hover:text-white text-slate-300 rounded px-2 py-0.5 text-[10px] transition-colors shadow-sm"
                        >
                          刪單
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Panel_OrderHistory;