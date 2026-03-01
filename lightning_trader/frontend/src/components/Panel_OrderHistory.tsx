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

const getStatusColor = (status: string) => {
  if (status === 'Filled') return 'text-green-400';
  if (status === 'Cancelled') return 'text-slate-500';
  if (['PendingSubmit', 'PreSubmitted', 'Submitted'].includes(status)) return 'text-yellow-400';
  if (['Failed', 'Rejected'].includes(status)) return 'text-red-400';
  return 'text-slate-100';
};

const Panel_OrderHistory: React.FC = () => {
  const { accountSummary } = useTradingContext();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const data = await getOrderHistory();
      setTrades(data);
    } catch (err) {
      console.error("Failed to fetch order history:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, [accountSummary]);

  return (
    <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">今日委託 (Order History)</h3>
        <button
          onClick={fetchHistory}
          className="text-xs bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded transition-colors"
        >
          重新整理
        </button>
      </div>

      <div className="flex-1 overflow-auto relative">
        {isLoading && (
          <div className="absolute inset-0 bg-slate-900/50 flex items-center justify-center z-10">
            <span className="text-slate-400 text-sm">Loading...</span>
          </div>
        )}
        <table className="w-full text-xs text-left">
          <thead className="sticky top-0 bg-slate-800 text-slate-500">
            <tr>
              <th className="pb-2 font-medium">時間</th>
              <th className="pb-2 font-medium">商品</th>
              <th className="pb-2 font-medium">方向</th>
              <th className="pb-2 font-medium text-right">委託價/量</th>
              <th className="pb-2 font-medium text-right">成交均價/量</th>
              <th className="pb-2 font-medium text-right">狀態</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {trades.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-500">今日尚無委託</td>
              </tr>
            ) : (
              trades.map((t, idx) => (
                <tr key={`${t.time}-${idx}`} className="hover:bg-white/5 transition-colors">
                  <td className="py-2 text-slate-400 font-mono">{t.time.split('T')[1]?.split('.')[0] || t.time}</td>
                  <td className="py-2 font-mono font-medium">{t.symbol}</td>
                  <td className={`py-2 font-bold ${t.action === 'Buy' ? 'text-red-400' : 'text-green-400'}`}>
                    {t.action === 'Buy' ? '買' : '賣'}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {t.price === 0 ? '市價' : t.price.toFixed(2)} / {t.qty}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {t.filled_qty > 0 ? t.filled_avg_price.toFixed(2) : '-'} / {t.filled_qty}
                  </td>
                  <td className={`py-2 text-right font-bold ${getStatusColor(t.status)}`}>
                    {t.status}
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
