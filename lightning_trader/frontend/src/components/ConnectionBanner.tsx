/**
 * ConnectionBanner — Dashboard 頂部的連線 / 行情狀態細橫幅（UX 批次 4 Item 2）
 *
 * 與 Header 連線燈號同一套優先序（口徑一致）：
 *   1. WS 斷線            → 紅「連線中斷，顯示為最後快照」
 *   2. 券商重連中 / 斷線   → 橘（後端 ConnectionState 推播）
 *   3. 有連線但無 Tick     → 灰「盤後 / 無行情」
 *   4. 正常               → 不渲染
 *
 * 純顯示元件：不跳 toast（重連成功 / 斷線的 toast 由 TradingContext 統一負責）。
 */
import React from 'react';
import { WifiOff, RefreshCw, MoonStar } from 'lucide-react';
import { useTradingCore } from '../contexts/TradingContext';

export const ConnectionBanner: React.FC = () => {
  const { isConnected, isTickStale, brokerState } = useTradingCore();

  const brokerTrouble = brokerState === 'reconnecting' || brokerState === 'disconnected';

  if (!isConnected) {
    return (
      <div
        data-testid="conn-banner"
        className="mb-2 -mx-4 px-4 py-1 bg-red-700/25 border-y border-red-500/50 flex items-center gap-2 text-red-200 text-[11px] font-bold"
      >
        <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
        <span>連線中斷，顯示為最後快照 — 重連中…</span>
      </div>
    );
  }

  if (brokerTrouble) {
    return (
      <div
        data-testid="conn-banner"
        className="mb-2 -mx-4 px-4 py-1 bg-orange-500/15 border-y border-orange-400/50 flex items-center gap-2 text-orange-300 text-[11px] font-bold"
      >
        <RefreshCw className="w-3.5 h-3.5 flex-shrink-0 animate-spin" />
        <span>{brokerState === 'reconnecting' ? '券商連線重建中，行情與回報可能延遲…' : '券商連線中斷，行情與委託暫不可用'}</span>
      </div>
    );
  }

  if (isTickStale) {
    return (
      <div
        data-testid="conn-banner"
        className="mb-2 -mx-4 px-4 py-1 bg-slate-600/20 border-y border-slate-500/40 flex items-center gap-2 text-slate-400 text-[11px] font-bold"
      >
        <MoonStar className="w-3.5 h-3.5 flex-shrink-0" />
        <span>盤後 / 無行情 — 目前沒有即時報價，顯示為最後成交狀態</span>
      </div>
    );
  }

  return null;
};

export default ConnectionBanner;
