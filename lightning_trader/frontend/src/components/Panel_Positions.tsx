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
  const { accountSummary } = useTradingContext();
  const [positions, setPositions] = useState<Position[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | 'STK' | 'FUT'>('ALL');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  const fetchAccounts = async () => {
    try {
      const data = await getAccounts();
      setAccounts(data);
    } catch (err) {
      console.error("Failed to fetch accounts:", err);
    }
  };

  const fetchPositions = async (accountId?: string) => {
    setIsLoading(true);
    try {
      const data = await getPositions(accountId);
      setPositions(data);
    } catch (err) {
      console.error("Failed to fetch positions:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
    fetchPositions();
  }, []);

  // 當類別或帳號 ID 改變時重新抓取
  useEffect(() => {
    fetchPositions(selectedAccountId || undefined);
  }, [selectedAccountId]);

  // 過濾後的帳號清單
  const filteredAccounts = useMemo(() => {
    if (selectedCategory === 'ALL') return accounts;
    return accounts.filter(acc => acc.category === selectedCategory);
  }, [accounts, selectedCategory]);

  // 當類別改變時，如果目前的 selectedAccountId 不在 filtered 內，清空它
  useEffect(() => {
    if (selectedAccountId && !filteredAccounts.find(a => a.account_id === selectedAccountId)) {
      setSelectedAccountId('');
    }
  }, [selectedCategory, filteredAccounts]);

  return (
    <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <div className="flex flex-col gap-3 mb-4">
        <div className="flex justify-between items-center">
          <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <span className="w-1.5 h-4 bg-emerald-500 rounded-full"></span>
            即時持倉 (Positions)
          </h3>
          <button
            onClick={() => fetchPositions(selectedAccountId)}
            className="text-[10px] bg-slate-700/50 hover:bg-slate-600 px-2 py-1 rounded transition-all text-slate-400 border border-slate-600"
          >
            重新整理
          </button>
        </div>

        {/* 控制列：類別與帳號選單 */}
        <div className="flex items-center gap-2">
          {/* 類別切換 */}
          <div className="flex bg-slate-900/50 p-0.5 rounded-md border border-slate-700/50 grow-0 shrink-0">
            {['ALL', 'STK', 'FUT'].map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat as any)}
                className={`px-3 py-1 text-[10px] font-bold rounded transition-all ${selectedCategory === cat
                    ? 'bg-blue-500 text-white shadow-lg'
                    : 'text-slate-500 hover:text-slate-300'
                  }`}
              >
                {cat === 'ALL' ? '全部' : cat === 'STK' ? '股票' : '期貨'}
              </button>
            ))}
          </div>

          {/* 帳號選單 */}
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="flex-1 bg-slate-900/80 border border-slate-700 text-slate-200 text-[10px] font-bold py-1 px-2 rounded-md outline-none focus:border-blue-500 transition-colors"
          >
            <option value="">所有帳號</option>
            {filteredAccounts.map(acc => (
              <option key={acc.account_id} value={acc.account_id}>
                {acc.account_name} ({acc.account_id})
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
                  <td className="px-2 py-2 font-mono text-slate-200">{pos.symbol}</td>
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
