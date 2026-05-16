import React, { useState, Suspense, lazy } from 'react';
import Header from './Header';
import DOMPanel from './DOMPanel';
// Focus mode 預設為 true → 以下 panels 在首載時不會顯示，懶載入掉
// 進入 layout 模式時 Suspense 會閃 100~200ms（網路慢時更明顯），可接受
const Panel_Positions       = lazy(() => import('./Panel_Positions'));
const Panel_OrderHistory    = lazy(() => import('./Panel_OrderHistory'));
const Panel_AccountBalance  = lazy(() => import('./Panel_AccountBalance'));
const Panel_TradeHistory    = lazy(() => import('./Panel_TradeHistory'));
const SettingsModal         = lazy(() => import('./SettingsModal'));
// ChartPanel 也走 lazy：lightweight-charts ~30KB gzipped、不要進首載
const ChartPanel            = lazy(() => import('./ChartPanel'));
// Sprint 12：自選 watchlist 也 lazy
const WatchlistPanel        = lazy(() => import('./WatchlistPanel'));
// Sprint 13：智慧單清單 lazy
const SmartOrdersPanel      = lazy(() => import('./SmartOrdersPanel'));
// Sprint 14：交易日誌 lazy
const JournalPanel          = lazy(() => import('./JournalPanel'));
// Sprint 15：已實現損益曲線 lazy（共用 lightweight-charts chunk）
const EquityCurvePanel      = lazy(() => import('./EquityCurvePanel'));
// Sprint 16：交易績效統計面板 lazy
const StatsPanel            = lazy(() => import('./StatsPanel'));
// Sprint 18：hotkey 速查表（非 lazy；很小、且 ? 觸發要永遠 mounted）
import { HotkeyCheatSheet } from './HotkeyCheatSheet';
import { TradingProvider, useTradingContext } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { LAYOUT_PRESETS, type LayoutPresetId } from '../utils/layoutPresets';
import { useElectronUpdater } from '../hooks/useElectronUpdater';
import { useFillNotification } from '../hooks/useFillNotification';
import { useRiskStatus } from '../hooks/useRiskStatus';
import { usePriceAlerts } from '../hooks/usePriceAlerts';
import { Responsive, WidthProvider } from 'react-grid-layout';
import { ShieldAlert, BarChart3, LayoutGrid } from 'lucide-react';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const ResponsiveGridLayout = WidthProvider(Responsive);

const defaultLayouts = {
  lg: [
    { i: 'watch',   x: 0,  y: 0,  w: 2, h: 22 },
    { i: 'dom',     x: 2,  y: 0,  w: 5, h: 22 },
    { i: 'chart',   x: 2,  y: 22, w: 5, h: 10 },
    { i: 'equity',  x: 0,  y: 22, w: 2, h: 10 },
    { i: 'stats',   x: 0,  y: 32, w: 7, h: 8 },
    { i: 'bal',     x: 7,  y: 0,  w: 5, h: 8 },
    { i: 'pos',     x: 7,  y: 8,  w: 5, h: 8 },
    { i: 'smart',   x: 7,  y: 16, w: 5, h: 8 },
    { i: 'journal', x: 7,  y: 24, w: 5, h: 8 },
    { i: 'hist',    x: 7,  y: 32, w: 3, h: 8 },
    { i: 'trade',   x: 10, y: 32, w: 2, h: 8 },
  ],
  md: [
    { i: 'watch',   x: 0, y: 0,  w: 2, h: 22 },
    { i: 'dom',     x: 2, y: 0,  w: 4, h: 22 },
    { i: 'chart',   x: 2, y: 22, w: 4, h: 10 },
    { i: 'equity',  x: 0, y: 22, w: 2, h: 10 },
    { i: 'stats',   x: 0, y: 32, w: 6, h: 8 },
    { i: 'bal',     x: 6, y: 0,  w: 4, h: 8 },
    { i: 'pos',     x: 6, y: 8,  w: 4, h: 8 },
    { i: 'smart',   x: 6, y: 16, w: 4, h: 8 },
    { i: 'journal', x: 6, y: 24, w: 4, h: 8 },
    { i: 'hist',    x: 6, y: 32, w: 2, h: 8 },
    { i: 'trade',   x: 8, y: 32, w: 2, h: 8 },
  ],
  sm: [
    { i: 'watch',   x: 0, y: 0,  w: 6, h: 8 },
    { i: 'dom',     x: 0, y: 8,  w: 6, h: 20 },
    { i: 'chart',   x: 0, y: 28, w: 6, h: 10 },
    { i: 'equity',  x: 0, y: 38, w: 6, h: 10 },
    { i: 'stats',   x: 0, y: 48, w: 6, h: 10 },
    { i: 'bal',     x: 0, y: 58, w: 6, h: 7 },
    { i: 'pos',     x: 0, y: 55, w: 6, h: 8 },
    { i: 'smart',   x: 0, y: 63, w: 6, h: 8 },
    { i: 'journal', x: 0, y: 71, w: 6, h: 8 },
    { i: 'hist',    x: 0, y: 79, w: 3, h: 8 },
    { i: 'trade',   x: 3, y: 79, w: 3, h: 8 },
  ]
};

// Sprint 16：新增 stats panel，bump key（既有 layout 會被替換為含 stats 的預設）
const LAYOUT_KEY = 'lighTrade_layout_v8';



const DashboardContent: React.FC = () => {
  const { settings, updateSetting } = useSettings();
  const activePreset = settings.layoutPreset;
  const presetDef = activePreset !== 'custom' ? LAYOUT_PRESETS[activePreset] : null;

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLayoutLocked, setIsLayoutLocked] = useState(true);
  // Sprint 31：focus 預設依 preset；custom 維持原本「預設專注模式」
  const [isFocusMode, setIsFocusMode] = useState(presetDef ? presetDef.focusMode : true);
  // Sprint 11 R1：focus mode 內的 DOM / Chart tab 切換
  const [focusTab, setFocusTab] = useState<'dom' | 'chart'>('dom');
  const { accountSummary } = useTradingContext();
  const isLive = accountSummary.is_simulation === false;
  // 桌面版接 Electron auto-updater 事件→Toast；非 Electron 環境會自動 no-op。
  useElectronUpdater();
  // 成交回報 → 系統通知 + Toast（視窗在後景才推系統通知）
  useFillNotification();
  // 30s 一次拉 backend RiskManager 狀態，給 banner 用
  const riskStatus = useRiskStatus();
  // Sprint 26：本地價格穿越警報
  usePriceAlerts();
  const tradingDisabled = riskStatus !== null && riskStatus.trading_enabled === false;

  const [layouts, setLayouts] = useState(() => {
    // preset 模式：lg 用 preset，md/sm 沿用既有預設（行動端不差異化）
    if (presetDef) return { ...defaultLayouts, lg: presetDef.lg };
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load layout from localstorage', e);
    }
    return defaultLayouts;
  });

  const applyPreset = (id: LayoutPresetId) => {
    updateSetting({ layoutPreset: id });
    if (id === 'custom') {
      try {
        const saved = localStorage.getItem(LAYOUT_KEY);
        setLayouts(saved ? JSON.parse(saved) : defaultLayouts);
      } catch {
        setLayouts(defaultLayouts);
      }
      return;
    }
    const def = LAYOUT_PRESETS[id];
    setLayouts({ ...defaultLayouts, lg: def.lg });
    setIsFocusMode(def.focusMode);
  };

  const handleLayoutChange = (_currentLayout: Array<{i: string; x: number; y: number; w: number; h: number}>, allLayouts: Record<string, Array<{i: string; x: number; y: number; w: number; h: number}>>) => {
    setLayouts(allLayouts);
    if (settings.layoutPreset === 'custom') {
      // 自訂模式：維持原行為，任何版面變動都持久化
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(allLayouts));
    } else if (!isLayoutLocked) {
      // preset 模式下「解鎖手動拖曳」→ 轉為自訂並持久化
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(allLayouts));
      updateSetting({ layoutPreset: 'custom' });
    }
    // preset 模式 + 鎖定：純 responsive reflow，不覆蓋使用者既有自訂版面
  };

  return (
    <div className={`min-h-screen bg-[var(--color-blue-gray-900)] text-slate-100 p-4 md:p-6 flex flex-col overflow-hidden max-h-screen relative ${isLive ? 'ring-2 ring-inset ring-red-500/70' : ''}`}>
      {isLive && (
        <div className="absolute top-1.5 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="px-3 py-0.5 bg-red-600/90 text-white text-[11px] font-black tracking-[0.3em] rounded-b shadow-lg border-x border-b border-red-400/70">
            ⚠ LIVE TRADING ⚠
          </div>
        </div>
      )}
      {tradingDisabled && (
        <div className="mb-2 -mx-4 px-4 py-1.5 bg-red-700/30 border-y border-red-500/60 flex items-center gap-2 text-red-200 text-xs font-bold">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          <span>
            風控已停止交易：可能因日虧損達上限。
            {riskStatus && (
              <>
                {' 目前損益 '}
                <span className="font-mono tabular-nums text-red-100">
                  {Math.round(riskStatus.daily_realized_pnl + riskStatus.daily_unrealized_pnl).toLocaleString()}
                </span>
                {' / 上限 '}
                <span className="font-mono tabular-nums text-red-100">
                  {Math.round(riskStatus.max_daily_loss).toLocaleString()}
                </span>
              </>
            )}
            <span className="ml-2 opacity-80">到「設定 → 風險控管」重置日虧損計數即可恢復。</span>
          </span>
        </div>
      )}
      <Header
        onOpenSettings={() => setIsSettingsOpen(true)}
        isLayoutLocked={isLayoutLocked}
        onToggleLayoutLock={() => setIsLayoutLocked(!isLayoutLocked)}
        isFocusMode={isFocusMode}
        onToggleFocusMode={() => setIsFocusMode(!isFocusMode)}
        layoutPreset={activePreset}
        onSelectPreset={applyPreset}
      />

      {isFocusMode ? (
        <div className="flex-1 -mx-4 px-4 pb-6 flex flex-col min-h-0">
          {/* Sprint 11 R1：focus mode 內加 tab — DOM vs Chart 切換 */}
          <div className="flex items-center gap-1 mb-2">
            <button
              onClick={() => setFocusTab('dom')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold border transition-colors ${
                focusTab === 'dom'
                  ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]'
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
              }`}
            >
              <LayoutGrid className="w-3 h-3" /> 閃電下單
            </button>
            <button
              onClick={() => setFocusTab('chart')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-bold border transition-colors ${
                focusTab === 'chart'
                  ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]'
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
              }`}
            >
              <BarChart3 className="w-3 h-3" /> K 線
            </button>
          </div>
          <div className="flex-1 overflow-hidden flex flex-col rounded-lg bg-[#101623] border border-slate-700/50 shadow-2xl">
            {focusTab === 'dom' ? (
              <DOMPanel />
            ) : (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-xs">載入 K 線中…</div>}>
                <ChartPanel />
              </Suspense>
            )}
          </div>
        </div>
      ) : (
        <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-xs">載入面板中…</div>}>
        <div className="flex-1 overflow-auto -mx-4 px-4 pb-12 min-h-0">
          <ResponsiveGridLayout
            className="layout"
            layouts={layouts}
            breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
            cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
            rowHeight={30}
            onLayoutChange={handleLayoutChange}
            isDraggable={!isLayoutLocked}
            isResizable={!isLayoutLocked}
            draggableHandle=".drag-handle"
            margin={[16, 16]}
          >
            <div key="dom" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 overflow-hidden flex flex-col"><DOMPanel /></div>
            </div>

            <div key="bal" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><Panel_AccountBalance /></div>
            </div>
            
            <div key="pos" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><Panel_Positions /></div>
            </div>
            
            <div key="hist" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><Panel_OrderHistory /></div>
            </div>

            <div key="trade" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><Panel_TradeHistory /></div>
            </div>

            <div key="chart" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><ChartPanel /></div>
            </div>

            <div key="watch" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><WatchlistPanel /></div>
            </div>

            <div key="smart" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><SmartOrdersPanel /></div>
            </div>

            <div key="journal" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><JournalPanel /></div>
            </div>

            <div key="equity" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><EquityCurvePanel /></div>
            </div>

            <div key="stats" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><StatsPanel /></div>
            </div>
          </ResponsiveGridLayout>
        </div>
        </Suspense>
      )}

      {/* SettingsModal 也走 lazy；isOpen=false 時 lazy chunk 不會載 */}
      {isSettingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
          />
        </Suspense>
      )}

      {/* Sprint 18：永遠 mount，自己監聽 `?` 鍵；無作用時不渲染。 */}
      <HotkeyCheatSheet />
    </div>
  );
};

const Dashboard: React.FC = () => {
  return (
    <TradingProvider>
      <DashboardContent />
    </TradingProvider>
  );
};

export default Dashboard;

