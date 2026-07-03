/**
 * useRiskStatus — 定時拉 /api/risk_status，把 backend RiskManager 的關鍵狀態
 * 上來給前端做警示。
 *
 * 為什麼需要：trading_enabled 在後端會被 RiskManager 自動翻成 false（例：
 * 日虧損到頂）。沒這個 hook 之前，使用者只會在下單被 RISK_BLOCK 才知道，
 * 並且不知道「為什麼」。
 *
 * 行為：
 *   - 每 30 秒拉一次（連線中才拉）
 *   - 偵測到 trading_enabled false→true 或 true→false 切換時觸發 onChange
 *   - 暴露目前 status 給 UI 渲染 banner / icon
 */
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { useTradingCore } from '../contexts/TradingContext';

export interface RiskStatus {
  trading_enabled: boolean;
  daily_realized_pnl: number;
  daily_unrealized_pnl: number;
  max_daily_loss: number;
  max_position_per_symbol: number;
}

const POLL_MS = 30_000;

export function useRiskStatus(): RiskStatus | null {
  const { isConnected } = useTradingCore();
  const [status, setStatus] = useState<RiskStatus | null>(null);
  const prevEnabledRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!isConnected) return;

    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await apiClient.get<RiskStatus>('/risk_status');
        if (cancelled) return;
        setStatus(res.data);
        prevEnabledRef.current = res.data.trading_enabled;
      } catch { /* 403/503 等情況靜默 — 不顯示 banner 即可 */ }
    };
    fetchOnce();
    const timer = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isConnected]);

  return status;
}
