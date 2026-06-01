import React from 'react';
import { useParams } from 'react-router-dom';
import { TradingProvider } from '../contexts/TradingContext';
import DOMPanel from './DOMPanel';
import Panel_Positions from './Panel_Positions';
import Panel_OrderHistory from './Panel_OrderHistory';
import Panel_AccountBalance from './Panel_AccountBalance';
import QuoteHistory from './QuoteHistory';

/**
 * PanelWindow — 單一面板獨立視窗（透過 Electron popout 開啟）
 *
 * 路由格式：/panel/:id
 *   - /panel/dom        → DOMPanel
 *   - /panel/positions  → Panel_Positions
 *   - /panel/history    → Panel_OrderHistory
 *   - /panel/account    → Panel_AccountBalance
 *   - /panel/quotes     → QuoteHistory
 *
 * 每個子視窗是獨立的 React tree，自帶一份 TradingProvider，
 * 會對 backend 建立自己的 WebSocket 連線，訂閱自己的 symbol。
 */
const panelRegistry: Record<string, { title: string; Comp: React.FC }> = {
  dom:       { title: 'DOM Panel',       Comp: DOMPanel },
  positions: { title: 'Positions',       Comp: Panel_Positions },
  history:   { title: 'Order History',   Comp: Panel_OrderHistory },
  account:   { title: 'Account Summary', Comp: Panel_AccountBalance },
  quotes:    { title: 'Quote History',   Comp: QuoteHistory },
};

const PanelWindow: React.FC = () => {
  const { id = '' } = useParams();
  const entry = panelRegistry[id];

  if (!entry) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center font-mono">
        <div className="text-center">
          <div className="text-xl mb-2 text-red-400">Unknown panel: {id}</div>
          <div className="text-sm text-slate-400">
            Expected one of: {Object.keys(panelRegistry).join(', ')}
          </div>
        </div>
      </div>
    );
  }

  const { Comp, title } = entry;

  return (
    <TradingProvider>
      <div className="min-h-screen h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900/80 border-b border-slate-700/50 select-none text-xs font-mono tracking-wider uppercase text-slate-400">
          <span>{title}</span>
          <span className="text-slate-600">popout</span>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <Comp />
        </div>
      </div>
    </TradingProvider>
  );
};

export default PanelWindow;