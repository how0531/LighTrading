import React, { useState } from 'react';
import Header from './Header';
import DOMPanel from './DOMPanel';
import Panel_Positions from './Panel_Positions';
import Panel_OrderHistory from './Panel_OrderHistory';
import SettingsModal from './SettingsModal';
import { TradingProvider } from '../contexts/TradingContext';

const DashboardContent: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[var(--color-blue-gray-900)] text-slate-100 p-4 md:p-6 flex flex-col overflow-hidden max-h-screen">
      <Header onOpenSettings={() => setIsSettingsOpen(true)} />

      <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0">
        {/* Left: Main Trading Panel (DOM) */}
        <div className="flex-[2] flex flex-col min-h-0">
          <DOMPanel />
        </div>

        {/* Right: Account & History Panels */}
        <div className="flex-1 flex flex-col gap-4 min-h-0">
          <div className="flex-1 min-h-0">
            <Panel_Positions />
          </div>
          <div className="flex-1 min-h-0">
            <Panel_OrderHistory />
          </div>
        </div>
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
