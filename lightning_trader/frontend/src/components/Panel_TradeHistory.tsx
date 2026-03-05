import React, { useEffect, useState, useCallback } from 'react';
import { getOrderHistory } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';

interface FilledTrade {
  time: string;
  symbol: string;
  action: 'Buy' | 'Sell';
  filled_avg_price: number;
  filled_qty: number;
}

const Panel_TradeHistory: React.FC = () => {
  const { accountSummary } = useTradingContext();
  const [trades, setTrades] = useState<FilledTrade[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTrades = useCallback(async () => {
    try {
      const data = await getOrderHistory();
      // 只保留已成交的委託
      const filled = (data || [])
        .filter((t: any) => t.status === 'Filled' && t.filled_qty > 0 && t.symbol?.trim())
        .map((t: any) => ({
          time: t.time,
          symbol: t.symbol,
          action: t.action as 'Buy' | 'Sell',
          filled_avg_price: t.filled_avg_price || 0,
          filled_qty: t.filled_qty || 0,
        }));
      setTrades(filled);
    } catch (e) {
      console.error('[TradeHistory] 取得成交明細失敗:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 使用 msg_count 作為 dependency，避免每個 tick 都觸發 HTTP 請求
  const accountMsgCount = accountSummary.msg_count;
  useEffect(() => {
    fetchTrades();
  }, [accountMsgCount, fetchTrades]);

  return (
    <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">成交明細</h3>
        <span className="text-[10px] text-slate-500 font-mono tabular-nums">{trades.length} 筆</span>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar relative">
        {isLoading && (
          <div className="absolute inset-0 bg-slate-900/50 flex items-center justify-center z-10">
            <span className="text-slate-400 text-sm">Loading...</span>
          </div>
        )}
        <table className="w-full text-[11px] text-left border-separate border-spacing-y-1">
          <thead className="sticky top-0 bg-[#1C2331] text-slate-500 z-10">
            <tr>
              <th className="px-2 py-1.5 font-medium border-b border-slate-700/50">時間</th>
              <th className="px-2 py-1.5 font-medium border-b border-slate-700/50">商品</th>
              <th className="px-2 py-1.5 font-medium border-b border-slate-700/50">方向</th>
              <th className="px-2 py-1.5 font-medium text-right border-b border-slate-700/50">成交均價</th>
              <th className="px-2 py-1.5 font-medium text-right border-b border-slate-700/50">成交量</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-slate-600 font-medium italic">今日尚無成交</td>
              </tr>
            ) : (
              trades.map((t, idx) => (
                <tr key={`${t.time}-${idx}`} className="hover:bg-white/5 transition-colors bg-slate-700/20">
                  <td className="px-2 py-1.5 text-slate-400 font-mono tabular-nums">
                    {t.time.split('T')[1]?.split('.')[0] || t.time}
                  </td>
                  <td className="px-2 py-1.5 font-mono font-medium text-slate-200">{t.symbol}</td>
                  <td className={`px-2 py-1.5 font-bold ${t.action === 'Buy' ? 'text-red-400' : 'text-green-400'}`}>
                    {t.action === 'Buy' ? '買' : '賣'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-slate-300">
                    {t.filled_avg_price > 0 ? t.filled_avg_price.toFixed(2) : '-'}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-[#D4AF37] font-bold">
                    {t.filled_qty}
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

export default Panel_TradeHistory;
