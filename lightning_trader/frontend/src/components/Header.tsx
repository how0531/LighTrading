import React, { useEffect, useState } from 'react';
import { useQuotes, useTradingCore } from '../contexts/TradingContext';
import { Activity, Settings, Lock, Unlock, Maximize, Minimize, RefreshCw, ShieldAlert, Zap } from 'lucide-react';
import { apiClient, getAccountBalance } from '../api/client';
import { SymbolPicker } from './SymbolPicker';
import PanicButton from './PanicButton';
import HealthStrip from './HealthStrip';
import { PRESET_ORDER, presetLabel, LAYOUT_PRESETS, type LayoutPresetId } from '../utils/layoutPresets';
import type { RiskStatus } from '../hooks/useRiskStatus';

const QUICK_SYMBOLS = ['TXFR1', 'MXFR1', '2330', '2454'] as const;

interface BalanceState {
  equity: number;
  margin_available: number;
  margin_required: number;
  pnl: number;
}

interface LatencyState {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

interface HeaderProps {
  onOpenSettings?: () => void;
  isLayoutLocked?: boolean;
  onToggleLayoutLock?: () => void;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
  layoutPreset?: LayoutPresetId;
  onSelectPreset?: (id: LayoutPresetId) => void;
  /** UX 批次 4 Item 3：日虧損儀表（Dashboard 的 useRiskStatus 傳入，避免重複輪詢） */
  riskStatus?: RiskStatus | null;
  /** Sprint D：⚡全開多 DOM 宮格（自選前 N 檔各開一個 MiniDOM 的全螢幕 overlay） */
  onOpenMultiDom?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onOpenSettings, isLayoutLocked = true, onToggleLayoutLock, isFocusMode = false, onToggleFocusMode, layoutPreset = 'custom', onSelectPreset, riskStatus = null, onOpenMultiDom }) => {
  const { isConnected, isTickStale, brokerState, targetSymbol, subscribe, forceReconnect } = useTradingCore();
  const { totalRealtimePnl } = useQuotes(); // 即時 PnL 跟著 tick 走 → 高頻 context
  const [symInput, setSymInput] = React.useState(targetSymbol);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [latency, setLatency] = useState<LatencyState | null>(null);

  useEffect(() => {
    if (!isConnected) return;
    const fetchBalance = () => {
      getAccountBalance().then((b: BalanceState) => {
        if (b && (b.equity || b.margin_required)) setBalance(b);
      }).catch(() => { /* 靜默 */ });
    };
    fetchBalance();
    const t = setInterval(fetchBalance, 15000); // 每 15 秒拉一次
    return () => clearInterval(t);
  }, [isConnected]);

  // Sprint 19：order latency 30s 拉一次
  useEffect(() => {
    if (!isConnected) return;
    const fetchLat = () => {
      // 走 apiClient：token 認證啟用時才會帶 X-API-Token（raw fetch 會 401）
      apiClient.get<{ latency?: LatencyState }>('/metrics')
        .then((r) => {
          if (r.data?.latency) setLatency(r.data.latency);
        })
        .catch(() => { /* 靜默 */ });
    };
    fetchLat();
    const t = setInterval(fetchLat, 30_000);
    return () => clearInterval(t);
  }, [isConnected]);

  const marginUsedPct = balance && balance.equity > 0
    ? Math.min(100, Math.round((balance.margin_required / balance.equity) * 100))
    : 0;

  // Item 3：日虧損儀表 — 當日損益 vs 日虧上限（max_daily_loss 為負值；>=0 視為未設定 → 隱藏）
  const dailyPnl = riskStatus
    ? riskStatus.daily_realized_pnl + riskStatus.daily_unrealized_pnl
    : 0;
  const hasLossLimit = riskStatus != null && riskStatus.max_daily_loss < 0;
  const lossUsedPct = hasLossLimit
    ? Math.min(100, Math.max(0, Math.round((Math.min(0, dailyPnl) / riskStatus!.max_daily_loss) * 100)))
    : 0;
  const riskLocked = riskStatus != null && riskStatus.trading_enabled === false;
  const lossBarColor = riskLocked || lossUsedPct >= 80 ? 'bg-red-500'
    : lossUsedPct >= 50 ? 'bg-amber-400'
    : 'bg-emerald-500';

  const handleSub = (e: React.FormEvent) => {
    e.preventDefault();
    if (symInput) subscribe(symInput);
  };

  // Item 11：四級連線狀態燈 — 優先序：WS 斷線 > 券商斷線/重連 > 無 TICK > 正常
  const brokerTrouble = brokerState === 'reconnecting' || brokerState === 'disconnected';
  const connLevel: 'offline' | 'broker' | 'notick' | 'online' =
    !isConnected ? 'offline'
    : brokerTrouble ? 'broker'
    : isTickStale ? 'notick'
    : 'online';
  const connDotClass = {
    offline: 'bg-[#EF4444]',
    broker: 'bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.5)]',
    notick: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]',
    online: 'bg-[#10B981] shadow-[0_0_6px_rgba(16,185,129,0.3)]',
  }[connLevel];
  const connLabel = {
    offline: 'OFFLINE',
    broker: brokerState === 'reconnecting' ? '券商重連中' : '券商斷線',
    notick: '無TICK/盤後',
    online: 'ONLINE',
  }[connLevel];

  return (
    <div className="glass-panel w-full px-5 py-3 rounded-lg flex items-center justify-between border border-slate-700/50 mb-6 transition-all duration-300">
      <div className="flex items-center gap-4">
        <Activity className={`w-6 h-6 ${isConnected ? 'text-[#10B981]' : 'text-red-500'}`} />
        <div>
          <h2 className="text-lg font-black tracking-[0.2em] text-white italic transition-transform hover:scale-105 cursor-default font-mono">LIGHTRADE</h2>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className={`w-1.5 h-1.5 rounded-full ${connDotClass}`}></div>
            <span className="text-[10px] text-slate-400 font-mono tracking-widest uppercase font-bold">
              {connLabel}
            </span>
            {connLevel !== 'online' && (
              <button
                type="button"
                onClick={forceReconnect}
                className="ml-1 flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 rounded text-[9px] font-bold border border-amber-500/40 transition-colors cursor-pointer"
                title="立即重連 WebSocket"
              >
                <RefreshCw className="w-2.5 h-2.5" />
                立即重連
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* 安全網：健康列 + 恐慌鈕（保命裝置，顯眼紅） */}
        <HealthStrip />
        <PanicButton />

        {/* 保證金 widget */}
        {balance && (
          <div className="hidden lg:flex flex-col items-end mr-2 min-w-[110px]">
            <span className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-0.5">可用保證金</span>
            <span className="text-sm font-black font-mono tabular-nums text-slate-200">
              {balance.margin_available.toLocaleString()}
            </span>
            <div className="flex items-center gap-1 mt-0.5 w-full">
              <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden">
                <div
                  className={`h-full transition-all ${marginUsedPct >= 80 ? 'bg-red-500' : marginUsedPct >= 60 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                  style={{ width: `${marginUsedPct}%` }}
                />
              </div>
              <span className={`text-[9px] font-mono tabular-nums ${marginUsedPct >= 80 ? 'text-red-400' : 'text-slate-500'}`}>{marginUsedPct}%</span>
            </div>
          </div>
        )}

        {/* Sprint 19：成交延遲 P50/P95 */}
        {latency && latency.count > 0 && (
          <div className="hidden xl:flex flex-col items-end mr-3" title={`量測 ${latency.count} 筆，max ${latency.max_ms}ms`}>
            <span className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-0.5">成交延遲</span>
            <span className={`text-xs font-mono tabular-nums ${
              (latency.p95_ms ?? 0) > 500 ? 'text-red-400'
              : (latency.p95_ms ?? 0) > 200 ? 'text-amber-300'
              : 'text-emerald-300'
            }`}>
              P50 {latency.p50_ms}ms · P95 {latency.p95_ms}ms
            </span>
          </div>
        )}

        {/* Item 3：日虧損儀表 — 虧損越接近上限 綠→黃→紅；熔斷時顯示鎖定 */}
        {hasLossLimit && (
          <div
            className="hidden md:flex flex-col items-end mr-2 min-w-[96px]"
            title={`當日損益 ${Math.round(dailyPnl).toLocaleString()} / 日虧上限 ${Math.round(riskStatus!.max_daily_loss).toLocaleString()}`}
            data-testid="daily-loss-gauge"
          >
            <span className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-0.5 flex items-center gap-1">
              {riskLocked && <ShieldAlert className="w-3 h-3 text-red-400" />}
              日虧損
            </span>
            <span className={`text-xs font-black font-mono tabular-nums ${riskLocked ? 'text-red-400' : dailyPnl < 0 ? 'text-slate-200' : 'text-slate-400'}`}>
              {riskLocked ? '已鎖定' : `${Math.round(dailyPnl).toLocaleString()}`}
            </span>
            <div className="flex items-center gap-1 mt-0.5 w-full">
              <div className="flex-1 h-1 bg-slate-800 rounded overflow-hidden">
                <div
                  className={`h-full transition-all ${lossBarColor}`}
                  style={{ width: `${riskLocked ? 100 : lossUsedPct}%` }}
                />
              </div>
              <span className={`text-[9px] font-mono tabular-nums ${lossUsedPct >= 80 || riskLocked ? 'text-red-400' : 'text-slate-500'}`}>
                {riskLocked ? '100' : lossUsedPct}%
              </span>
            </div>
          </div>
        )}

        {/* 帳戶總即時損益 */}
        <div className="hidden md:flex flex-col items-end mr-4">
          <span className="text-[10px] text-slate-500 font-bold tracking-widest uppercase mb-0.5">總即時損益</span>
          <span className={`text-sm font-black font-mono tabular-nums ${totalRealtimePnl >= 0 ? 'text-red-400 drop-shadow-[0_0_8px_rgba(248,113,113,0.3)]' : 'text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.3)]'}`}>
            {totalRealtimePnl > 0 ? '+' : ''}{totalRealtimePnl.toLocaleString()}
          </span>
        </div>

        <form onSubmit={handleSub} className="flex items-center gap-3">
          <label className="text-xs text-slate-400 uppercase tracking-wider font-semibold hidden md:block font-mono">Active Symbol</label>
          <div className="flex bg-slate-900 rounded border border-slate-700 overflow-hidden focus-within:border-[#D4AF37] transition-all shadow-inner">
            <input
              type="text"
              value={symInput}
              onChange={(e) => setSymInput(e.target.value)}
              className="bg-transparent text-slate-200 px-3 py-1.5 outline-none font-mono w-24 text-sm placeholder-slate-600 font-bold"
              placeholder="SYMBOL..."
            />
            <button type="submit" className="bg-slate-800 text-slate-400 hover:bg-[#D4AF37] hover:text-white px-3 py-1.5 text-[10px] font-black tracking-tighter border-l border-slate-700 transition-all uppercase">
              LOAD
            </button>
          </div>
          <div className="hidden lg:block">
            <SymbolPicker onSelect={(s) => { setSymInput(s); subscribe(s); }} />
          </div>

          <div className="hidden lg:flex items-center gap-1">
            {QUICK_SYMBOLS.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => { setSymInput(s); subscribe(s); }}
                className={`px-2 py-1 text-[10px] font-mono font-bold rounded border transition-all cursor-pointer ${
                  targetSymbol === s
                    ? 'bg-[#D4AF37]/20 border-[#D4AF37] text-[#D4AF37]'
                    : 'bg-slate-800/50 border-slate-700 text-slate-400 hover:border-[#D4AF37]/50 hover:text-slate-200'
                }`}
                title={`快速切換到 ${s}`}
              >
                {s}
              </button>
            ))}
          </div>
        </form>

        {/* Sprint 31：版面 preset 選擇 — 依交易風格一鍵切版 */}
        <div className="hidden md:flex flex-col items-end mr-1">
          <span className="text-[9px] text-slate-500 font-bold tracking-widest uppercase mb-0.5">版面</span>
          <select
            value={layoutPreset}
            onChange={(e) => onSelectPreset?.(e.target.value as LayoutPresetId)}
            title={layoutPreset !== 'custom' ? LAYOUT_PRESETS[layoutPreset as Exclude<LayoutPresetId, 'custom'>]?.desc : '使用者自訂拖曳版面'}
            className="bg-slate-900 border border-slate-700 rounded text-[11px] font-bold py-1 px-1.5 text-[#D4AF37] outline-none cursor-pointer hover:border-[#D4AF37]/50 transition-colors"
          >
            {PRESET_ORDER.map((id) => (
              <option key={id} value={id}>{presetLabel(id)}</option>
            ))}
          </select>
        </div>

        {/* Sprint D：⚡全開 — 自選前 N 檔各開一個 MiniDOM 的全螢幕宮格 */}
        {onOpenMultiDom && (
          <button
            onClick={onOpenMultiDom}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg transition-all border bg-slate-800 text-amber-300/90 border-slate-700 hover:border-amber-400/60 hover:text-amber-300 hover:shadow-[0_0_8px_rgba(251,191,36,0.25)] cursor-pointer"
            title="⚡全開：自選清單前 N 檔各開一個迷你 DOM 宮格（點格下單；Esc 關閉）"
            data-testid="open-multidom"
          >
            <Zap className="w-4 h-4" />
            <span className="text-[11px] font-black tracking-wider hidden md:inline">全開</span>
          </button>
        )}

        <button
          onClick={onToggleFocusMode}
          className={`p-2 rounded-lg transition-all border ${isFocusMode ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37] hover:bg-[#D4AF37]/30 shadow-[0_0_8px_rgba(212,175,55,0.4)]' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-300'}`}
          title={isFocusMode ? "退出專注模式 (展開帳務)" : "專注模式 (隱藏帳務)"}
        >
          {isFocusMode ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
        </button>

        <button 
          onClick={onToggleLayoutLock}
          className={`p-2 rounded-lg transition-all border ${isLayoutLocked ? 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-300' : 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37] hover:bg-[#D4AF37]/30 shadow-[0_0_8px_rgba(212,175,55,0.4)]'}`}
          title={isLayoutLocked ? "解鎖版面配置" : "鎖定並儲存版面"}
        >
          {isLayoutLocked ? <Lock className="w-5 h-5" /> : <Unlock className="w-5 h-5" />}
        </button>

        <button 
          onClick={onOpenSettings}
          className="p-2 bg-slate-800 text-slate-400 hover:text-[#D4AF37] hover:bg-slate-700 rounded-lg transition-all border border-slate-700 hover:border-[#D4AF37]/50"
          title="系統設定"
        >
          <Settings className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};

export default Header;
