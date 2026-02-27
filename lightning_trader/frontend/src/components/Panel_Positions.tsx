import React, { useEffect, useState } from 'react';
import { getPositions } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';

interface Position {
  symbol: string;
  qty: number;
  direction: 'Buy' | 'Sell';
  price: number;
  pnl: number;
}

const Panel_Positions: React.FC = () => {
  const { accountSummary } = useTradingContext();
  const [positions, setPositions] = useState<Position[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPositions = async () => {
    try {
      const data = await getPositions();
      setPositions(data);
    } catch (err) {
      console.error("Failed to fetch positions:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPositions();
    // Also update when accountSummary changes via WebSocket
    if (accountSummary?.positions) {
      // ShioajiClient includes positions in accountSummary update
      // But we mapped it slightly differently in the backend signal_account_update.emit
      // Let's re-fetch from API for full details if needed, 
      // or just rely on the WebSocket data if it's sufficient.
      // For now, let's keep it simple and refresh from API on change.
      fetchPositions();
    }
  }, [accountSummary]);

  return (
    <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700 h-full flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">即時持倉 (Positions)</h3>
        <button 
          onClick={fetchPositions}
          className="text-xs bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded transition-colors"
        >
          重新整理
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs text-left">
          <thead className="sticky top-0 bg-slate-800 text-slate-500">
            <tr>
              <th className="pb-2 font-medium">代碼</th>
              <th className="pb-2 font-medium">方向</th>
              <th className="pb-2 font-medium text-right">數量</th>
              <th className="pb-2 font-medium text-right">均價</th>
              <th className="pb-2 font-medium text-right">損益</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {positions.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-slate-500">尚無部位</td>
              </tr>
            ) : (
              positions.map((pos, idx) => (
                <tr key={`${pos.symbol}-${idx}`} className="hover:bg-white/5 transition-colors">
                  <td className="py-2 font-mono">{pos.symbol}</td>
                  <td className={`py-2 font-bold ${pos.direction === 'Buy' ? 'text-red-400' : 'text-green-400'}`}>
                    {pos.direction === 'Buy' ? '多' : '空'}
                  </td>
                  <td className="py-2 text-right">{pos.qty}</td>
                  <td className="py-2 text-right font-mono">{pos.price.toFixed(2)}</td>
                  <td className={`py-2 text-right font-mono font-bold ${pos.pnl >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {pos.pnl > 0 ? '+' : ''}{pos.pnl.toLocaleString()}
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

export default Panel_Positions;
