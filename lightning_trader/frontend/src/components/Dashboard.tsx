import React, { useState } from 'react';
import Header from './Header';
import DOMPanel from './DOMPanel';
import Panel_Positions from './Panel_Positions';
import Panel_OrderHistory from './Panel_OrderHistory';
import Panel_AccountBalance from './Panel_AccountBalance';
import Panel_TradeHistory from './Panel_TradeHistory';
import Panel_TimeAndSales from './Panel_TimeAndSales';
import Panel_VWAP from './Panel_VWAP';
import SizingCalculator from './SizingCalculator';
import SmartOrderForm from './SmartOrderForm';
import SettingsModal from './SettingsModal';
import { TradingProvider, useTradingContext } from '../contexts/TradingContext';
import { Responsive, WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const ResponsiveGridLayout = WidthProvider(Responsive);

// Layout 版本提升至 v3：新增 tns / vwap / size / smart 四個 panel
const defaultLayouts = {
  lg: [
    { i: 'dom', x: 0, y: 0, w: 5, h: 22 },
    { i: 'tns', x: 5, y: 0, w: 2, h: 14 },
    { i: 'vwap', x: 5, y: 14, w: 2, h: 8 },
    { i: 'bal', x: 7, y: 0, w: 5, h: 6 },
    { i: 'pos', x: 7, y: 6, w: 5, h: 8 },
    { i: 'size', x: 7, y: 14, w: 2, h: 8 },
    { i: 'smart', x: 9, y: 14, w: 3, h: 8 },
    { i: 'hist', x: 7, y: 22, w: 3, h: 6 },
    { i: 'trade', x: 10, y: 22, w: 2, h: 6 },
  ],
  md: [
    { i: 'dom', x: 0, y: 0, w: 4, h: 22 },
    { i: 'tns', x: 4, y: 0, w: 2, h: 14 },
    { i: 'vwap', x: 4, y: 14, w: 2, h: 8 },
    { i: 'bal', x: 6, y: 0, w: 4, h: 6 },
    { i: 'pos', x: 6, y: 6, w: 4, h: 8 },
    { i: 'size', x: 6, y: 14, w: 2, h: 8 },
    { i: 'smart', x: 8, y: 14, w: 2, h: 8 },
    { i: 'hist', x: 6, y: 22, w: 2, h: 6 },
    { i: 'trade', x: 8, y: 22, w: 2, h: 6 },
  ],
  sm: [
    { i: 'dom', x: 0, y: 0, w: 6, h: 20 },
    { i: 'tns', x: 0, y: 20, w: 3, h: 10 },
    { i: 'vwap', x: 3, y: 20, w: 3, h: 6 },
    { i: 'bal', x: 0, y: 30, w: 6, h: 6 },
    { i: 'pos', x: 0, y: 36, w: 6, h: 8 },
    { i: 'size', x: 0, y: 44, w: 3, h: 10 },
    { i: 'smart', x: 3, y: 44, w: 3, h: 10 },
    { i: 'hist', x: 0, y: 54, w: 3, h: 8 },
    { i: 'trade', x: 3, y: 54, w: 3, h: 8 },
  ]
};

const LAYOUT_KEY = 'lighTrade_layout_v3';



const DashboardContent: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLayoutLocked, setIsLayoutLocked] = useState(true);
  const [isFocusMode, setIsFocusMode] = useState(true); // 預設為專注模式
  const { accountSummary } = useTradingContext();
  const isLive = accountSummary.is_simulation === false;

  const [layouts, setLayouts] = useState(() => {
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load layout from localstorage', e);
    }
    return defaultLayouts;
  });

  const handleLayoutChange = (_currentLayout: Array<{i: string; x: number; y: number; w: number; h: number}>, allLayouts: Record<string, Array<{i: string; x: number; y: number; w: number; h: number}>>) => {
    setLayouts(allLayouts);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(allLayouts));
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
      <Header
        onOpenSettings={() => setIsSettingsOpen(true)} 
        isLayoutLocked={isLayoutLocked}
        onToggleLayoutLock={() => setIsLayoutLocked(!isLayoutLocked)}
        isFocusMode={isFocusMode}
        onToggleFocusMode={() => setIsFocusMode(!isFocusMode)}
      />

      {isFocusMode ? (
        <div className="flex-1 -mx-4 px-4 pb-6 flex flex-col min-h-0">
          <div className="flex-1 overflow-hidden flex flex-col rounded-lg bg-[#101623] border border-slate-700/50 shadow-2xl">
            <DOMPanel />
          </div>
        </div>
      ) : (
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

            <div key="tns" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><Panel_TimeAndSales /></div>
            </div>

            <div key="vwap" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><Panel_VWAP /></div>
            </div>

            <div key="size" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><SizingCalculator /></div>
            </div>

            <div key="smart" className={`flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
              {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
              <div className="flex-1 h-full overflow-hidden flex flex-col"><SmartOrderForm /></div>
            </div>
          </ResponsiveGridLayout>
        </div>
      )}

      <SettingsModal 
        isOpen={isSettingsOpen} 
        onClose={() => setIsSettingsOpen(false)} 
      />
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

