import React, { createContext, useContext, useState, useEffect } from 'react';

// 快捷鍵行為定義
export interface HotkeyItem {
  key: string;          // e.g. "F1", "Escape", "q", " "
  action: 'Buy' | 'Sell' | 'CancelAll' | 'Flatten' | 'ScrollCenter';
  label: string;
}

// 拆單設定
export interface SplitOrderConfig {
  enabled: boolean;
  threshold: number;   // 超過此張數才拆
  minPerLot: number;   // 每筆最少張數
  maxPerLot: number;   // 每筆最多張數
  minDelay: number;    // 每筆送出最小間隔 ms
  maxDelay: number;    // 每筆送出最大間隔 ms
}

/**
 * 交易系統設定介面
 */
export interface Settings {
  orderMode: 'Qty' | 'Amount';
  isCombatMode: boolean;
  confirmations: {
    placeOrder: boolean;
    cancelOrder: boolean;
    flatten: boolean;
  };
  visuals: {
    showVWAP: boolean;
    showHL: boolean;
    showVolumeProfile: boolean;
    fontSize: number;
  };
  theme: 'dark' | 'light';
  hotkeys: HotkeyItem[];
  splitOrder: SplitOrderConfig;
}

/**
 * 預設設定值 (DAWHO 風格建議預設為 dark)
 */
const DEFAULT_SETTINGS: Settings = {
  orderMode: 'Qty',
  isCombatMode: false,
  confirmations: {
    placeOrder: true,
    cancelOrder: true,
    flatten: true,
  },
  visuals: {
    showVWAP: true,
    showHL: true,
    showVolumeProfile: true,
    fontSize: 12,
  },
  theme: 'dark',
  hotkeys: [
    { key: 'F1',     action: 'Buy',          label: '買進 (Buy)' },
    { key: 'F2',     action: 'Sell',         label: '賣出 (Sell)' },
    { key: 'Escape', action: 'CancelAll',    label: '全刪掛單' },
    { key: 'Delete', action: 'Flatten',      label: '全部平倉' },
    { key: ' ',      action: 'ScrollCenter', label: '置中 (捲動到現價)' },
  ],
  splitOrder: {
    enabled: false,
    threshold: 499,
    minPerLot: 1,
    maxPerLot: 10,
    minDelay: 200,
    maxDelay: 800,
  },
};

interface SettingsContextType {
  settings: Settings;
  updateSetting: (updates: Partial<Settings> | ((prev: Settings) => Settings)) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);
const STORAGE_KEY = 'lightrade_settings';

/**
 * SettingsProvider 負責狀態持久化與主題管理
 */
export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<Settings>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          confirmations: { ...DEFAULT_SETTINGS.confirmations, ...parsed.confirmations },
          visuals: { ...DEFAULT_SETTINGS.visuals, ...parsed.visuals },
          hotkeys: parsed.hotkeys || DEFAULT_SETTINGS.hotkeys,
          splitOrder: { ...DEFAULT_SETTINGS.splitOrder, ...parsed.splitOrder },
        };
      } catch (e) {
        console.error("Failed to parse settings from localStorage", e);
      }
    }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    if (settings.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    document.documentElement.style.setProperty('--base-font-size', `${settings.visuals.fontSize || 12}px`);
  }, [settings]);

  const updateSetting = (updates: Partial<Settings> | ((prev: Settings) => Settings)) => {
    setSettings(prev => {
      if (typeof updates === 'function') return updates(prev);
      const next = { ...prev, ...updates };
      if (updates.confirmations) next.confirmations = { ...prev.confirmations, ...updates.confirmations };
      if (updates.visuals) next.visuals = { ...prev.visuals, ...updates.visuals };
      if (updates.splitOrder) next.splitOrder = { ...prev.splitOrder, ...updates.splitOrder };
      return next;
    });
  };

  const resetSettings = () => setSettings(DEFAULT_SETTINGS);

  return (
    <SettingsContext.Provider value={{ settings, updateSetting, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used within a SettingsProvider');
  return context;
};
