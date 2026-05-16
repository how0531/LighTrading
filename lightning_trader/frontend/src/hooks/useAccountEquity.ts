/**
 * useAccountEquity — 取得帳戶總權益（台幣）
 *
 * 用於 sizing.equityPctToLots 換算。每 30 秒輪詢一次 /account_balance，
 * 不需要 sub-second 精度（只在使用者按下下單前用一次）。
 *
 * 與 Panel_AccountBalance 的 5s 輪詢分離以避免 useDOMLogic 依賴 Panel 的渲染順序。
 */
import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';

export function useAccountEquity(): number {
  const [equity, setEquity] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await apiClient.get('/account_balance');
        if (cancelled) return;
        const v = res.data?.equity;
        if (typeof v === 'number' && v > 0) setEquity(v);
      } catch {
        // 後端未上線、未登入皆靜默；equity_pct 模式會回 0 lots
      }
    };
    fetchOnce();
    const timer = setInterval(fetchOnce, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return equity;
}
