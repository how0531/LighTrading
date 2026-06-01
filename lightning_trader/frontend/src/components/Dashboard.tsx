import React, { useState } from 'react';
import Header from './Header';
import DOMPanel from './DOMPanel';
import Panel_Positions from './Panel_Positions';
import Panel_OrderHistory from './Panel_OrderHistory';
import SettingsModal from './SettingsModal';
import { TradingProvider } from '../contexts/TradingContext';
import { Responsive, WidthProvider } from 'react-grid-layout';
import { ExternalLink } from 'lucide-react';
import { LAYOUT_PRESETS, type LayoutPresetId } from '../utils/layoutPresets';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

// 呼叫 Electron 把面板彈成獨立視窗；瀏覽器環境則 fallback 新分頁
const popoutPanel = (route: string, title: string, width = 480, height = 600) => {
  const api = (window as unknown as { electronAPI?: { popoutPanel?: (r: string, opts: object) => Promise<unknown> } }).electronAPI;
  if (api?.popoutPanel) {
    api.popoutPanel(route, { title, width, height });
  } else {
    // 非 Electron 環境：新分頁
    window.open(`${window.location.pathname}#${route}`, '_blank', `width=${width},height=${height}`);
  }
};

const PopoutBtn: React.FC<{ route: string; title: string; w?: number; h?: number }> = ({ route, title, w, h }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); popoutPanel(route, title, w, h); }}
    title={`Pop out: ${title}`}
    className="absolute top-1 right-1 z-20 p-1 rounded bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
  >
    <ExternalLink size={14} />
  </button>
);

const ResponsiveGridLayout = WidthProvider(Responsive);

const defaultLayouts = {
  lg: [
    { i: 'dom', x: 0, y: 0, w: 7, h: 22 },
    { i: 'pos', x: 7, y: 0, w: 5, h: 10 },
    { i: 'hist', x: 7, y: 10, w: 5, h: 12 }
  ],
  md: [
    { i: 'dom', x: 0, y: 0, w: 6, h: 22 },
    { i: 'pos', x: 6, y: 0, w: 4, h: 10 },
    { i: 'hist', x: 6, y: 10, w: 4, h: 12 }
  ],
  sm: [
    { i: 'dom', x: 0, y: 0, w: 6, h: 20 },
    { i: 'pos', x: 0, y: 20, w: 6, h: 10 },
    { i: 'hist', x: 0, y: 30, w: 6, h: 12 }
  ]
};

const LAYOUT_KEY = 'lighTrade_layout';
const PRESET_KEY = 'lighTrade_preset';

const DashboardContent: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLayoutLocked, setIsLayoutLocked] = useState(true);
  const [isFocusMode, setIsFocusMode] = useState(false);

  const [layoutPreset, setLayoutPreset] = useState<LayoutPresetId>(() => {
    return (localStorage.getItem(PRESET_KEY) as LayoutPresetId) || 'custom';
  });

  const [layouts, setLayouts] = useState(() => {
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load layout from localstorage', e);
    }
    return defaultLayouts;
  });

  const handleLayoutChange = (_currentLayout: any, allLayouts: any) => {
    setLayouts(allLayouts);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(allLayouts));
    
    // Switch to custom preset if layout is manually changed
    if (layoutPreset !== 'custom') {
      setLayoutPreset('custom');
      localStorage.setItem(PRESET_KEY, 'custom');
    }
  };

  const handleSelectPreset = (id: LayoutPresetId) => {
    setLayoutPreset(id);
    localStorage.setItem(PRESET_KEY, id);
    
    if (id !== 'custom') {
      const preset = LAYOUT_PRESETS[id as keyof typeof LAYOUT_PRESETS];
      if (preset) {
        setIsFocusMode(preset.focusMode);
        const newLayouts = { ...layouts, lg: preset.lg };
        setLayouts(newLayouts);
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(newLayouts));
      }
    }
  };

  return (
    <div className={`h-screen bg-[var(--color-blue-gray-900)] text-slate-100 p-4 md:p-6 flex flex-col overflow-hidden ${isFocusMode ? 'focus-mode' : ''}`}>
      <Header 
        onOpenSettings={() => setIsSettingsOpen(true)} 
        isLayoutLocked={isLayoutLocked}
        onToggleLayoutLock={() => setIsLayoutLocked(!isLayoutLocked)}
        layoutPreset={layoutPreset}
        onSelectPreset={handleSelectPreset}
        isFocusMode={isFocusMode}
        onToggleFocusMode={() => setIsFocusMode(!isFocusMode)}
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
          <div key="dom" className={`relative flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
            {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
            <PopoutBtn route="/panel/dom" title="DOM Panel" w={520} h={760} />
            <div className="flex-1 h-full overflow-hidden flex flex-col"><DOMPanel /></div>
          </div>

          <div key="pos" className={`relative flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
            {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
            <PopoutBtn route="/panel/positions" title="Positions" w={560} h={420} />
            <div className="flex-1 h-full overflow-hidden flex flex-col"><Panel_Positions /></div>
          </div>

          <div key="hist" className={`relative flex flex-col overflow-hidden rounded-lg ${!isLayoutLocked ? 'ring-1 ring-slate-500 bg-slate-800/20' : ''}`}>
            {!isLayoutLocked && <div className="drag-handle bg-slate-700/80 hover:bg-slate-700 text-center py-1 text-xs text-slate-300 cursor-move tracking-widest uppercase font-bold transition-colors">DRAG</div>}
            <PopoutBtn route="/panel/history" title="Order History" w={640} h={480} />
            <div className="flex-1 h-full overflow-hidden flex flex-col"><Panel_OrderHistory /></div>
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
