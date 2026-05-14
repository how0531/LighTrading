import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { apiClient } from '../api/client';

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
    compactMode: boolean;     // ★ Sprint 10 R7a：DOM row 高度 h-8 → h-6（多 ~33% 可視檔位）
  };
  theme: 'dark' | 'light';
  hotkeys: HotkeyItem[];
  splitOrder: SplitOrderConfig;
  /** Sprint 20：per-symbol 預設下單口數 / 張數
   *  key 為 canonical symbol（全大寫），value 為正整數。
   *  使用者切到該 symbol 時，UI 自動把 orderValue 設為此值；找不到就保持當前值。 */
  qtyBySymbol: Record<string, number>;
  /** Sprint 22：通知 webhook（Discord/Slack/Telegram 通用）
   *  backend 直接從 ~/.lightrade/user_settings.json 讀，前端負責編輯。 */
  notifications: {
    webhookUrl: string;
    events: {
      fill: boolean;
      risk_breach: boolean;
    };
  };
  /** Sprint 23：自選清單跨裝置同步 — 從 localStorage 搬進 SettingsContext，
   *  自動透過 /api/user_settings 跨裝置同步。 */
  watchlist: string[];
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
    compactMode: false,
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
  qtyBySymbol: {},
  notifications: {
    webhookUrl: '',
    events: { fill: false, risk_breach: false },
  },
  watchlist: ['TXFR1', 'MXFR1', '2330', '2454', '0050'],
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
          qtyBySymbol: { ...DEFAULT_SETTINGS.qtyBySymbol, ...(parsed.qtyBySymbol || {}) },
          notifications: {
            webhookUrl: parsed.notifications?.webhookUrl ?? DEFAULT_SETTINGS.notifications.webhookUrl,
            events: { ...DEFAULT_SETTINGS.notifications.events, ...(parsed.notifications?.events || {}) },
          },
          watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : DEFAULT_SETTINGS.watchlist,
        };
      } catch (e) {
        console.error("Failed to parse settings from localStorage", e);
      }
    }
    return DEFAULT_SETTINGS;
  });

  // 後端同步：載入時拉一次；之後每次變更 debounce 800ms 寫回
  const hydratedFromServerRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    apiClient.get('/user_settings').then((res) => {
      if (cancelled) return;
      const remote = res.data?.data;
      if (remote && typeof remote === 'object') {
        setSettings((prev) => ({
          ...prev,
          ...remote,
          confirmations: { ...prev.confirmations, ...(remote.confirmations || {}) },
          visuals: { ...prev.visuals, ...(remote.visuals || {}) },
          hotkeys: remote.hotkeys || prev.hotkeys,
          splitOrder: { ...prev.splitOrder, ...(remote.splitOrder || {}) },
        }));
      }
      hydratedFromServerRef.current = true;
    }).catch(() => {
      hydratedFromServerRef.current = true;  // 後端不可用就只走 localStorage
    });
    return () => { cancelled = true; };
  }, []);

  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    if (settings.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    document.documentElement.style.setProperty('--base-font-size', `${settings.visuals.fontSize || 12}px`);

    // debounced 後端同步
    if (!hydratedFromServerRef.current) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      apiClient.put('/user_settings', { data: settings }).catch(() => { /* 靜默，localStorage 為主 */ });
    }, 800);
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
