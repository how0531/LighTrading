/* eslint-disable react-refresh/only-export-components --
 * Context Provider 與 hook 需同檔共享；改動本檔會整頁 HMR reload，可接受 */
import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { apiClient } from '../api/client';
import { configureSound } from '../utils/sound';
import type { SizingMode } from '../utils/sizing';
import type { FeeConfig } from '../utils/fees';
import { DEFAULT_FEE_CONFIG } from '../utils/fees';
import type { ChaseFinalAction } from '../utils/chase';
import type { ChartIndicatorSettings } from '../utils/chartIndicatorSettings';
import {
  defaultChartIndicatorSettings,
  normalizeChartIndicatorSettings,
} from '../utils/chartIndicatorSettings';

/** Sprint 28：智慧下單尺寸。
 *  mode 決定按下下單時最終口數的來源：
 *    - lots：傳統，直接以張/口（向後相容 orderValue UI）
 *    - amount：固定金額，按當下價自動換算口數
 *    - equity_pct：以總權益百分比下單，按當下價自動換算
 *  presets 為快捷鈕；hotkeyMultiplier 是熱鍵 1-9 在該模式下的單位倍率
 *  （amount=100000 = 1=10萬, 5=50萬；equity_pct=5 = 1=5%, 4=20%）。
 */
export interface SizingSettings {
  mode: SizingMode;
  amount: number;
  equityPct: number;
  amountPresets: number[];
  equityPctPresets: number[];
  hotkeyAmountUnit: number;
  hotkeyEquityPctUnit: number;
}

// 快捷鍵行為定義
// UX 批次 4 Item 8：新增追買（賣一價掛買）/ 追賣（買一價掛賣）/ 市價買賣。
// 「市價單送出」拆成買/賣兩個 action —— 無方向的市價熱鍵在交易終端太危險。
export interface HotkeyItem {
  key: string;          // e.g. "F1", "Escape", "q", " "
  action: 'Buy' | 'Sell' | 'CancelAll' | 'Flatten' | 'ScrollCenter'
        | 'ChaseBuy' | 'ChaseSell' | 'MarketBuy' | 'MarketSell';
  label: string;
}

/** Sprint C：追價（CHASE）智慧單預設參數。
 *  maxChaseTicks → max_chase_ticks；finalAction → final_action。
 *  reprice_ticks / reprice_interval_ms 用 utils/chase.ts 的預設值，不開放設定。 */
export interface ChaseSettings {
  maxChaseTicks: number;
  finalAction: ChaseFinalAction;
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
  isCombatMode: boolean;
  confirmations: {
    placeOrder: boolean;
    cancelOrder: boolean;
    flatten: boolean;
  };
  visuals: {
    showVWAP: boolean;
    showHL: boolean;
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
    /** 操作音效（下單 / 刪單 / 改單 / 成交提示音）開關與音量（0–1） */
    sound: {
      enabled: boolean;
      volume: number;
    };
  };
  /** Sprint 23：自選清單跨裝置同步 — 從 localStorage 搬進 SettingsContext，
   *  自動透過 /api/user_settings 跨裝置同步。 */
  watchlist: string[];
  /** Sprint 26：本地價格穿越警報 — 在 quote stream 內偵測，純前端觸發 toast/notification */
  priceAlerts: PriceAlert[];
  /** Sprint 28：智慧下單尺寸（金額 / % 權益 / 張數） */
  sizing: SizingSettings;
  /** Sprint 29：交易成本模型 — 把毛 PnL 換算成扣費後實際入袋 */
  fees: FeeConfig;
  /** Sprint 29：PnL 是否以「淨額（扣費後）」顯示；false = 顯示毛額 */
  showNetPnL: boolean;
  /** Sprint 31 / 34：版面 preset。custom = 沿用使用者拖曳儲存的版面（向後相容預設）。 */
  layoutPreset: 'momentum' | 'daytrade' | 'swing' | 'marketwatch' | 'custom';
  /** Sprint C：DOM 追價模式送出 CHASE 智慧單時的預設參數 */
  chase: ChaseSettings;
  /** Sprint E：圖表技術指標系統 — 啟用清單 + 參數 + 線樣式 + 收藏 + 自訂 JS 指標（含 code） */
  chart: ChartIndicatorSettings;
}

/** 單一價格警報。symbol 是 canonical symbol。op above = 價格 >= price；below = <=。 */
export interface PriceAlert {
  id: string;
  symbol: string;
  op: 'above' | 'below';
  price: number;
  enabled: boolean;
  triggeredAt?: number;   // unix ms；已觸發後不再 fire，直到使用者 reset
}

/**
 * 預設設定值 (DAWHO 風格建議預設為 dark)
 */
const DEFAULT_SETTINGS: Settings = {
  isCombatMode: false,
  confirmations: {
    placeOrder: true,
    cancelOrder: true,
    flatten: true,
  },
  visuals: {
    showVWAP: true,
    showHL: true,
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
    // UX 批次 4 Item 8
    { key: 'q',      action: 'ChaseBuy',     label: '追買 (賣一價掛買)' },
    { key: 'w',      action: 'ChaseSell',    label: '追賣 (買一價掛賣)' },
    { key: 'a',      action: 'MarketBuy',    label: '市價買進' },
    { key: 's',      action: 'MarketSell',   label: '市價賣出' },
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
    sound: { enabled: true, volume: 0.6 },
  },
  watchlist: ['TXFR1', 'MXFR1', '2330', '2454', '0050'],
  priceAlerts: [],
  sizing: {
    mode: 'lots',
    amount: 100_000,
    equityPct: 5,
    amountPresets: [100_000, 200_000, 500_000, 1_000_000],
    equityPctPresets: [5, 10, 20],
    hotkeyAmountUnit: 100_000,
    hotkeyEquityPctUnit: 5,
  },
  fees: DEFAULT_FEE_CONFIG,
  showNetPnL: false,
  layoutPreset: 'custom',
  chase: {
    maxChaseTicks: 10,
    finalAction: 'GIVE_UP',
  },
  chart: defaultChartIndicatorSettings(),
};

/** 舊版（localStorage / 後端）存的 hotkeys 沒有新 action（追買/追賣/市價）
 *  → 用預設補齊缺少的 action；使用者已占用的按鍵不覆蓋（避免衝突）。 */
function mergeHotkeys(saved: unknown): HotkeyItem[] {
  const base = Array.isArray(saved)
    ? (saved as HotkeyItem[]).filter((h) => h && typeof h.key === 'string' && typeof h.action === 'string')
    : [];
  if (base.length === 0) return DEFAULT_SETTINGS.hotkeys;
  const existingActions = new Set(base.map((h) => h.action));
  const usedKeys = new Set(base.map((h) => h.key));
  const additions = DEFAULT_SETTINGS.hotkeys.filter(
    (d) => !existingActions.has(d.action) && !usedKeys.has(d.key),
  );
  return additions.length > 0 ? [...base, ...additions] : base;
}

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
          hotkeys: mergeHotkeys(parsed.hotkeys),
          splitOrder: { ...DEFAULT_SETTINGS.splitOrder, ...parsed.splitOrder },
          qtyBySymbol: { ...DEFAULT_SETTINGS.qtyBySymbol, ...(parsed.qtyBySymbol || {}) },
          notifications: {
            webhookUrl: parsed.notifications?.webhookUrl ?? DEFAULT_SETTINGS.notifications.webhookUrl,
            events: { ...DEFAULT_SETTINGS.notifications.events, ...(parsed.notifications?.events || {}) },
            sound: { ...DEFAULT_SETTINGS.notifications.sound, ...(parsed.notifications?.sound || {}) },
          },
          watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : DEFAULT_SETTINGS.watchlist,
          priceAlerts: Array.isArray(parsed.priceAlerts) ? parsed.priceAlerts : DEFAULT_SETTINGS.priceAlerts,
          sizing: { ...DEFAULT_SETTINGS.sizing, ...(parsed.sizing || {}) },
          fees: { ...DEFAULT_SETTINGS.fees, ...(parsed.fees || {}) },
          showNetPnL: typeof parsed.showNetPnL === 'boolean' ? parsed.showNetPnL : DEFAULT_SETTINGS.showNetPnL,
          layoutPreset: parsed.layoutPreset || DEFAULT_SETTINGS.layoutPreset,
          chase: { ...DEFAULT_SETTINGS.chase, ...(parsed.chase || {}) },
          chart: normalizeChartIndicatorSettings(parsed.chart),
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
          hotkeys: mergeHotkeys(remote.hotkeys || prev.hotkeys),
          splitOrder: { ...prev.splitOrder, ...(remote.splitOrder || {}) },
          sizing: { ...prev.sizing, ...(remote.sizing || {}) },
          fees: { ...prev.fees, ...(remote.fees || {}) },
          chase: { ...prev.chase, ...(remote.chase || {}) },
          chart: remote.chart ? normalizeChartIndicatorSettings(remote.chart) : prev.chart,
          notifications: {
            ...prev.notifications,
            ...(remote.notifications || {}),
            events: { ...prev.notifications.events, ...(remote.notifications?.events || {}) },
            sound: { ...prev.notifications.sound, ...(remote.notifications?.sound || {}) },
          },
        }));
      }
      hydratedFromServerRef.current = true;
    }).catch(() => {
      hydratedFromServerRef.current = true;  // 後端不可用就只走 localStorage
    });
    return () => { cancelled = true; };
  }, []);

  // 音效開關/音量 → 注入 utils/sound 的模組層級設定（playSound 免 context 穿透）
  useEffect(() => {
    configureSound(settings.notifications.sound);
  }, [settings.notifications.sound]);

  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // quota 爆掉 / 隱私模式不可寫 → 降級：僅記憶體 + 後端同步,不要 throw 進 effect
    }
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
      if (updates.sizing) next.sizing = { ...prev.sizing, ...updates.sizing };
      if (updates.fees) next.fees = { ...prev.fees, ...updates.fees };
      if (updates.chase) next.chase = { ...prev.chase, ...updates.chase };
      // chart：active/custom 為陣列（整組替換語意）,不做深 merge；
      // IndicatorPicker 一律以 functional update 寫入完整物件
      if (updates.chart) next.chart = { ...prev.chart, ...updates.chart };
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
