import React, { useState } from 'react';
import Header from './Header';
import DOMPanel from './DOMPanel';
import Panel_Positions from './Panel_Positions';
import Panel_OrderHistory from './Panel_OrderHistory';
import Panel_AccountBalance from './Panel_AccountBalance';
import Panel_TradeHistory from './Panel_TradeHistory';
import SettingsModal from './SettingsModal';
import { TradingProvider } from '../contexts/TradingContext';
import { Responsive, WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const ResponsiveGridLayout = WidthProvider(Responsive);

const defaultLayouts = {
  lg: [
    { i: 'dom', x: 0, y: 0, w: 7, h: 22 },
    { i: 'bal', x: 7, y: 0, w: 5, h: 8 },
    { i: 'pos', x: 7, y: 8, w: 5, h: 8 },
    { i: 'hist', x: 7, y: 16, w: 3, h: 8 },
    { i: 'trade', x: 10, y: 16, w: 2, h: 8 },
  ],
  md: [
    { i: 'dom', x: 0, y: 0, w: 6, h: 22 },
    { i: 'bal', x: 6, y: 0, w: 4, h: 8 },
    { i: 'pos', x: 6, y: 8, w: 4, h: 8 },
    { i: 'hist', x: 6, y: 16, w: 2, h: 8 },
    { i: 'trade', x: 8, y: 16, w: 2, h: 8 },
  ],
  sm: [
    { i: 'dom', x: 0, y: 0, w: 6, h: 20 },
    { i: 'bal', x: 0, y: 20, w: 6, h: 7 },
    { i: 'pos', x: 0, y: 27, w: 6, h: 8 },
    { i: 'hist', x: 0, y: 35, w: 3, h: 8 },
    { i: 'trade', x: 3, y: 35, w: 3, h: 8 },
  ]
};

const LAYOUT_KEY = 'lighTrade_layout_v2';

const DashboardContent: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLayoutLocked, setIsLayoutLocked] = useState(true);

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
    <div className="min-h-screen bg-[var(--color-blue-gray-900)] text-slate-100 p-4 md:p-6 flex flex-col overflow-hidden max-h-screen">
      <Header 
        onOpenSettings={() => setIsSettingsOpen(true)} 
        isLayoutLocked={isLayoutLocked}
        onToggleLayoutLock={() => setIsLayoutLocked(!isLayoutLocked)}
      />

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
            <div className="flex-1 h-full overflow-hidden flex flex-col"><DOMPanel /></div>
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
        </ResponsiveGridLayout>
      </div>

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

