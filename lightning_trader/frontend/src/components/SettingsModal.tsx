import React, { useState } from 'react';
import { X, Settings as SettingsIcon, MousePointer2, Keyboard, Palette, Check, Monitor } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';
import type { Settings } from '../contexts/SettingsContext';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = 'transaction' | 'dom' | 'hotkeys' | 'appearance';

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { settings, updateSetting, resetSettings } = useSettings();
  const [activeTab, setActiveTab] = useState<TabType>('transaction');

  if (!isOpen) return null;

  const tabs = [
    { id: 'transaction' as TabType, label: '交易設定', icon: MousePointer2 },
    { id: 'dom' as TabType, label: '閃電下單', icon: Monitor },
    { id: 'hotkeys' as TabType, label: '熱鍵設定', icon: Keyboard },
    { id: 'appearance' as TabType, label: '外觀設定', icon: Palette },
  ];

  const handleToggle = (category: keyof Settings, field: string) => {
    const currentCategory = settings[category] as any;
    updateSetting({
      [category]: {
        ...currentCategory,
        [field]: !currentCategory[field]
      }
    });
  };

  const handleUpdate = (updates: Partial<Settings>) => {
    updateSetting(updates);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm transition-opacity duration-200">
      <div 
        className="relative w-full max-w-2xl h-[500px] flex overflow-hidden bg-[#1C2331] border border-[#29344A] rounded-xl shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <div className="w-48 bg-[#101623] border-r border-[#29344A] flex flex-col py-6">
          <div className="px-6 mb-8 flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-[#D4AF37]" />
            <span className="font-bold text-white tracking-wide">系統設定</span>
          </div>

          <nav className="flex-1 px-2 space-y-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                    isActive 
                      ? 'bg-[#D4AF37]/10 text-[#D4AF37] border-l-2 border-[#D4AF37] translate-x-1' 
                      : 'text-slate-400 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-[#D4AF37]' : ''}`} />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          <div className="px-4 mt-auto">
            <button 
              onClick={resetSettings}
              className="w-full py-2 text-xs text-slate-500 hover:text-[#D4AF37] transition-colors border border-slate-700/50 rounded hover:border-[#D4AF37]/30"
            >
              重設所有設定
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#1C2331]/50">
          {/* Header */}
          <div className="h-16 flex items-center justify-between px-8 border-b border-[#29344A]">
            <h2 className="text-lg font-semibold text-white">
              {tabs.find(t => t.id === activeTab)?.label}
            </h2>
            <button 
              onClick={onClose}
              className="p-2 hover:bg-white/5 rounded-full text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Scrollable Area */}
          <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
            
            {activeTab === 'transaction' && (
              <div className="space-y-6">
                <section>
                  <h3 className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider mb-4">交易模式</h3>
                  <div className="flex gap-2">
                    {['Qty', 'Amount'].map((mode) => (
                      <button
                        key={mode}
                        onClick={() => handleUpdate({ orderMode: mode as 'Qty' | 'Amount' })}
                        className={`px-4 py-2 rounded border text-sm transition-all ${
                          settings.orderMode === mode 
                            ? 'bg-[#D4AF37] border-[#D4AF37] text-[#101623] font-bold' 
                            : 'border-[#29344A] text-slate-400 hover:border-slate-500'
                        }`}
                      >
                        {mode === 'Qty' ? '張數 (Qty)' : '金額 (Amount)'}
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider mb-4">下單確認</h3>
                  <div className="space-y-3">
                    <ToggleItem 
                      label="委託下單確認" 
                      description="在送出委託前顯示確認對話框"
                      enabled={settings.confirmations.placeOrder}
                      onToggle={() => handleToggle('confirmations', 'placeOrder')}
                    />
                    <ToggleItem 
                      label="刪單確認" 
                      description="在取消委託前顯示確認對話框"
                      enabled={settings.confirmations.cancelOrder}
                      onToggle={() => handleToggle('confirmations', 'cancelOrder')}
                    />
                    <ToggleItem 
                      label="平倉確認" 
                      description="在全平或單向平倉前顯示確認對話框"
                      enabled={settings.confirmations.flatten}
                      onToggle={() => handleToggle('confirmations', 'flatten')}
                    />
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'dom' && (
              <div className="space-y-6">
                <section>
                  <h3 className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider mb-4">視覺呈現</h3>
                  <div className="space-y-3">
                    <ToggleItem 
                      label="顯示 VWAP" 
                      description="在閃電下單列顯示成交均價線"
                      enabled={settings.visuals.showVWAP}
                      onToggle={() => handleToggle('visuals', 'showVWAP')}
                    />
                    <ToggleItem 
                      label="顯示 今日高低點" 
                      description="標記今日最高價與最低價"
                      enabled={settings.visuals.showHL}
                      onToggle={() => handleToggle('visuals', 'showHL')}
                    />
                    <ToggleItem 
                      label="顯示 成交量分布 (Volume Profile)" 
                      description="顯示各價位成交量分布圖"
                      enabled={settings.visuals.showVolumeProfile}
                      onToggle={() => handleToggle('visuals', 'showVolumeProfile')}
                    />
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'hotkeys' && (
              <div className="space-y-6">
                <section>
                  <h3 className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider mb-4">全域快捷鍵</h3>
                  <div className="space-y-4">
                    <HotkeyRow keys={['Space']} action="回歸中心 (閃電下單)" />
                    <HotkeyRow keys={['Esc']} action="全刪 (所有掛單)" />
                    <HotkeyRow keys={['Alt', 'S']} action="全平 (所有倉位)" />
                    <HotkeyRow keys={['F1']} action="切換下單模式 (張數/金額)" />
                  </div>
                  <p className="mt-6 text-xs text-slate-500 italic">
                    * 目前僅支援預設快捷鍵，自定義功能將在後續版本開放。
                  </p>
                </section>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-8">
                <section>
                  <h3 className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider mb-4">主題風格</h3>
                  <div className="flex gap-4">
                    <ThemeCard 
                      theme="dark" 
                      label="大戶深色 (Dark)" 
                      isActive={settings.theme === 'dark'} 
                      onClick={() => handleUpdate({ theme: 'dark' })} 
                    />
                    <ThemeCard 
                      theme="light" 
                      label="明亮模式 (Light)" 
                      isActive={settings.theme === 'light'} 
                      onClick={() => handleUpdate({ theme: 'light' })} 
                    />
                  </div>
                </section>

                <section>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider">介面字體大小</h3>
                    <span className="text-[#D4AF37] font-mono font-bold">{settings.visuals.fontSize}px</span>
                  </div>
                  <input 
                    type="range" 
                    min="8" 
                    max="24" 
                    step="1"
                    value={settings.visuals.fontSize}
                    onChange={(e) => updateSetting({ 
                      visuals: { ...settings.visuals, fontSize: parseInt(e.target.value) } 
                    })}
                    className="w-full h-1.5 bg-[#29344A] rounded-lg appearance-none cursor-pointer accent-[#D4AF37]"
                  />
                  <div className="flex justify-between mt-2 text-[10px] text-slate-500 font-mono">
                    <span>8px</span>
                    <span>16px</span>
                    <span>24px</span>
                  </div>
                </section>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};

// Helper Components
const ToggleItem = ({ label, description, enabled, onToggle }: any) => (
  <div className="flex items-center justify-between p-4 rounded-lg bg-white/5 border border-white/5 hover:border-white/10 transition-all">
    <div>
      <div className="text-sm font-medium text-white">{label}</div>
      <div className="text-xs text-slate-500 mt-0.5">{description}</div>
    </div>
    <button 
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
        enabled ? 'bg-[#D4AF37]' : 'bg-[#29344A]'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  </div>
);

const HotkeyRow = ({ keys, action }: any) => (
  <div className="flex items-center justify-between py-2 border-b border-[#29344A]">
    <span className="text-sm text-slate-300">{action}</span>
    <div className="flex gap-1">
      {keys.map((k: string) => (
        <kbd key={k} className="px-2 py-1 bg-[#101623] border border-[#29344A] rounded text-[10px] font-mono text-[#D4AF37] shadow-inner">
          {k}
        </kbd>
      ))}
    </div>
  </div>
);

const ThemeCard = ({ theme, label, isActive, onClick }: any) => (
  <button 
    onClick={onClick}
    className={`flex-1 group relative p-4 rounded-xl border-2 transition-all duration-300 overflow-hidden ${
      isActive ? 'border-[#D4AF37] bg-[#D4AF37]/5' : 'border-[#29344A] bg-[#101623] hover:border-slate-500'
    }`}
  >
    <div className={`aspect-video rounded mb-3 overflow-hidden border ${isActive ? 'border-[#D4AF37]/50' : 'border-slate-800'}`}>
      <div className={`w-full h-full ${theme === 'dark' ? 'bg-[#101623]' : 'bg-slate-100'} flex p-2 gap-1`}>
        <div className={`w-1/3 h-full rounded ${theme === 'dark' ? 'bg-[#1C2331]' : 'bg-slate-300'}`} />
        <div className="flex-1 space-y-1">
          <div className={`w-full h-2 rounded ${theme === 'dark' ? 'bg-[#D4AF37]/20' : 'bg-blue-200'}`} />
          <div className={`w-2/3 h-2 rounded ${theme === 'dark' ? 'bg-[#29344A]' : 'bg-slate-300'}`} />
        </div>
      </div>
    </div>
    <span className={`text-xs font-bold ${isActive ? 'text-[#D4AF37]' : 'text-slate-400 group-hover:text-white'}`}>
      {label}
    </span>
    {isActive && (
      <div className="absolute top-2 right-2 w-4 h-4 bg-[#D4AF37] rounded-full flex items-center justify-center">
        <Check className="w-2.5 h-2.5 text-[#101623]" />
      </div>
    )}
  </button>
);

export default SettingsModal;
