import React, { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../api/client';
import { useTradingContext } from '../contexts/TradingContext';

interface BalanceData {
  equity: number;
  margin_available: number;
  margin_required: number;
  pnl: number;
}

const Panel_AccountBalance: React.FC = () => {
  const { isConnected, totalRealtimePnl, accountSummary } = useTradingContext();
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchBalance = useCallback(async () => {
    try {
      const res = await apiClient.get('/account_balance');
      if (res.data && typeof res.data.equity === 'number') {
        setBalance(res.data);
      }
    } catch (e) {
      console.error('[AccountBalance] 取得餘額失敗:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 連線後每 5 秒輪詢一次餘額
  useEffect(() => {
    if (!isConnected) return;
    fetchBalance();
    const timer = setInterval(fetchBalance, 5000);
    return () => clearInterval(timer);
  }, [isConnected, fetchBalance]);

  // 計算維持率
  const maintenanceRate = balance && balance.margin_required > 0
    ? (balance.margin_available / balance.margin_required * 100)
    : 999;

  // 已實現損益（後端提供）
  const realizedPnl = accountSummary["參考損益"] || 0;
  // 未實現損益（前端即時計算）
  const unrealizedPnl = totalRealtimePnl;
  // 當日合計
  const totalDayPnl = realizedPnl + unrealizedPnl;

  return (
    <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700 h-full flex flex-col glass-panel shadow-2xl">
      <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3">帳戶總覽</h3>

      {/* 今日損益匯總 — 三欄 */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className={`rounded border px-2 py-1.5 text-center ${realizedPnl >= 0 ? 'border-red-800/40 bg-red-950/20' : 'border-emerald-800/40 bg-emerald-950/20'}`}>
          <div className="text-[8px] text-slate-500 font-bold uppercase">已實現</div>
          <div className={`text-[12px] font-mono font-black tabular-nums ${realizedPnl >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {realizedPnl > 0 ? '+' : ''}{realizedPnl.toLocaleString()}
          </div>
        </div>
        <div className={`rounded border px-2 py-1.5 text-center ${unrealizedPnl >= 0 ? 'border-red-800/40 bg-red-950/20' : 'border-emerald-800/40 bg-emerald-950/20'}`}>
          <div className="text-[8px] text-slate-500 font-bold uppercase">未實現</div>
          <div className={`text-[12px] font-mono font-black tabular-nums ${unrealizedPnl >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {unrealizedPnl > 0 ? '+' : ''}{unrealizedPnl.toLocaleString()}
          </div>
        </div>
        <div className={`rounded border px-2 py-1.5 text-center ${totalDayPnl >= 0 ? 'border-amber-600/40 bg-amber-950/20' : 'border-emerald-800/40 bg-emerald-950/20'}`}>
          <div className="text-[8px] text-slate-500 font-bold uppercase">當日合計</div>
          <div className={`text-[13px] font-mono font-black tabular-nums ${totalDayPnl >= 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
            {totalDayPnl > 0 ? '+' : ''}{totalDayPnl.toLocaleString()}
          </div>
        </div>
      </div>

      {/* 保證金資訊 */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">載入中...</div>
      ) : balance ? (
        <div className="space-y-2 text-[11px]">
          <div className="flex justify-between items-center">
            <span className="text-slate-500">總權益</span>
            <span className="font-mono tabular-nums text-slate-200 font-bold">{balance.equity.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-500">可用保證金</span>
            <span className="font-mono tabular-nums text-slate-300">{balance.margin_available.toLocaleString()}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-500">已用保證金</span>
            <span className="font-mono tabular-nums text-slate-400">{balance.margin_required.toLocaleString()}</span>
          </div>
          <div className={`flex justify-between items-center rounded px-2 py-1 ${maintenanceRate < 100 ? 'bg-red-900/30 border border-red-700/50' : 'bg-slate-700/30'}`}>
            <span className={maintenanceRate < 100 ? 'text-red-400 font-bold' : 'text-slate-500'}>
              維持率 {maintenanceRate < 100 && '⚠️'}
            </span>
            <span className={`font-mono tabular-nums font-bold ${maintenanceRate < 100 ? 'text-red-400' : maintenanceRate < 150 ? 'text-yellow-400' : 'text-emerald-400'}`}>
              {maintenanceRate.toFixed(1)}%
            </span>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-xs italic">尚無餘額資料</div>
      )}
    </div>
  );
};

export default Panel_AccountBalance;
