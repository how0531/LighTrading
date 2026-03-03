import React, { useEffect, useState, useMemo } from 'react';
import { getPositions, getAccounts } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';

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
  const { isConnected, accountSummary, subscribe } = useTradingContext();
  const [positions, setPositions] = useState<Position[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | 'Stock' | 'Future'>('ALL');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  const fetchAccounts = async () => {
    try {
      const data = await getAccounts();
      console.log("DEBUG: 獲取到的帳號清單:", data);
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
    // 使用不區分大小寫的匹配，增加容錯
    const target = selectedCategory.toLowerCase();
    return accounts.filter(acc => {
      if (!acc.category) return false;
      const cat = acc.category.toLowerCase();
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
            {[
              { id: 'ALL', label: '全' },
              { id: 'Stock', label: '證' },
              { id: 'Future', label: '期' },
              { id: 'Future', label: '權' } // 權通常在期裡面，點擊同樣篩選 Future
            ].map((cat, idx) => (
              <button
                key={`${cat.id}-${idx}`}
                onClick={() => setSelectedCategory(cat.id as 'ALL' | 'Stock' | 'Future')}
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
              <th className="px-2 py-2 font-medium border-b border-slate-700/50">代碼</th>
              <th className="px-2 py-2 font-medium border-b border-slate-700/50">方向</th>
              <th className="px-2 py-2 font-medium text-right border-b border-slate-700/50">數量</th>
              <th className="px-2 py-2 font-medium text-right border-b border-slate-700/50">均價</th>
              <th className="px-2 py-2 font-medium text-right border-b border-slate-700/50">損益</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-slate-600 font-medium tracking-widest italic">尚無部位</td>
              </tr>
            ) : (
              positions.map((pos, idx) => (
                <tr key={`${pos.symbol}-${idx}`} className="bg-slate-700/20 hover:bg-slate-700/40 transition-colors">
                  <td 
                    className="px-2 py-2 font-mono text-slate-200 cursor-pointer hover:text-[#D4AF37] hover:underline transition-colors" 
                    onClick={() => subscribe(pos.symbol)}
                    title={`點擊切換至 ${pos.symbol}`}
                  >{pos.symbol}</td>
                  <td className={`px-2 py-2 font-extrabold ${pos.direction === 'Buy' ? 'text-red-500' : 'text-green-500'}`}>
                    <span className={`inline-block px-1 rounded ${pos.direction === 'Buy' ? 'bg-red-500/10' : 'bg-green-500/10'}`}>
                      {pos.direction === 'Buy' ? '多' : '空'}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-300">{pos.qty}</td>
                  <td className="px-2 py-2 text-right font-mono text-slate-400">{pos.price.toLocaleString()}</td>
                  <td className={`px-2 py-2 text-right font-mono font-bold ${pos.pnl >= 0 ? 'text-red-500 shadow-red-500/10' : 'text-green-500 shadow-green-500/10'}`}>
                    <span className={pos.pnl !== 0 ? 'drop-shadow-[0_0_8px_rgba(0,0,0,0.5)]' : ''}>
                      {pos.pnl > 0 ? '+' : ''}{pos.pnl.toLocaleString()}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isLoading && (
        <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1px] flex items-center justify-center rounded-lg pointer-events-none">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
    </div>
  );
};

export default Panel_Positions;
