import React, { createContext, useContext, useState, useEffect } from 'react';

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
        // 合併預設值以確保新增的欄位能被正確初始化
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          confirmations: { ...DEFAULT_SETTINGS.confirmations, ...parsed.confirmations },
          visuals: { ...DEFAULT_SETTINGS.visuals, ...parsed.visuals },
        };
      } catch (e) {
        console.error("Failed to parse settings from localStorage", e);
      }
    }
    return DEFAULT_SETTINGS;
  });

  // 持久化儲存與主題切換
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    
    // 同步 Tailwind Dark Mode 類別
    if (settings.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    
    // 設定全域字體大小 (透過 CSS 變數)
    document.documentElement.style.setProperty('--base-font-size', `${settings.visuals.fontSize || 12}px`);
  }, [settings]);

  /**
   * 支援部分更新與深層合併
   */
  const updateSetting = (updates: Partial<Settings> | ((prev: Settings) => Settings)) => {
    setSettings(prev => {
      if (typeof updates === 'function') {
        return updates(prev);
      }

      const next = { ...prev, ...updates };
      
      // 處理巢狀物件的合併
      if (updates.confirmations) {
        next.confirmations = { ...prev.confirmations, ...updates.confirmations };
      }
      if (updates.visuals) {
        next.visuals = { ...prev.visuals, ...updates.visuals };
      }
      
      return next;
    });
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSetting, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};

/**
 * Hook: useSettings
 * 方便在組件中存取與更新設定
 */
export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};
