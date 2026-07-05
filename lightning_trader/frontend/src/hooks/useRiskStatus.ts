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
 *   - Item 13：trading_enabled true→false → toast.error + 音效 + 桌面通知；
 *     false→true → toast.success（第一次 poll 只記錄基準，不吵人）
 *   - 暴露目前 status 給 UI 渲染 banner / icon
 *
 * 注意：WS RiskStatusUpdate（TradingContext）是即時告警的主要路徑；
 * 這裡的 poll 轉場偵測是後援（WS 訊息掉了 / 老後端沒廣播也能在 30s 內看到）。
 */
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { useTradingCore } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';
import { playSound } from '../utils/sound';

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
  const { toast } = useToast();
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
        // Item 13：偵測 trading_enabled 轉場（第一次 poll prev=null 只記錄基準）
        const prev = prevEnabledRef.current;
        const enabled = res.data.trading_enabled;
        prevEnabledRef.current = enabled;
        if (prev !== null && prev !== enabled) {
          if (!enabled) {
            const pnl = Math.round(res.data.daily_realized_pnl + res.data.daily_unrealized_pnl);
            const reason = `風控已停止交易：日損益 ${pnl.toLocaleString()} / 上限 ${Math.round(res.data.max_daily_loss).toLocaleString()}`;
            toast.error(reason);
            playSound('risk_halt');
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              try {
                new Notification('風控熔斷', { body: reason, tag: 'risk-halt' });
              } catch { /* iOS Safari 某些情境會拋；toast 已涵蓋 */ }
            }
          } else {
            toast.success('風控已恢復，可繼續交易');
          }
        }
      } catch { /* 403/503 等情況靜默 — 不顯示 banner 即可 */ }
    };
    fetchOnce();
    const timer = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isConnected, toast]);

  return status;
}
