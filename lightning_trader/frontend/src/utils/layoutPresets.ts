/**
 * layoutPresets.ts — Sprint 31：依交易風格切換桌面版面
 *
 * 痛點來源：
 *  - Sven 波段：預設 focus mode 對波段戶不對味，每次得手動關
 *  - Daisy 當沖：focus mode 看不到部位/當日損益
 *
 * 設計：preset 只覆蓋桌面 lg 版面 + focus 預設；md / sm 沿用 Dashboard
 * 既有預設（行動/平板本來就單欄堆疊，差異意義不大），把風險面縮到最小。
 *
 * panel keys 必須與 Dashboard 渲染的 11 個 grid item 完全一致：
 *   watch dom chart equity stats bal pos smart journal hist trade
 */
export type LayoutPresetId = 'momentum' | 'daytrade' | 'swing' | 'custom';

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutPreset {
  label: string;
  desc: string;
  focusMode: boolean;
  /** lg(12 cols) 版面；focusMode=true 時不影響顯示但仍保留供退出 focus 用 */
  lg: GridItem[];
}

// 當沖：DOM 大、帳務/部位即時可見、chart 小、績效類縮到底部
const DAYTRADE_LG: GridItem[] = [
  { i: 'dom',     x: 0,  y: 0,  w: 7, h: 24 },
  { i: 'bal',     x: 7,  y: 0,  w: 5, h: 7 },
  { i: 'pos',     x: 7,  y: 7,  w: 5, h: 10 },
  { i: 'chart',   x: 7,  y: 17, w: 5, h: 7 },
  { i: 'smart',   x: 0,  y: 24, w: 4, h: 8 },
  { i: 'hist',    x: 4,  y: 24, w: 3, h: 8 },
  { i: 'trade',   x: 7,  y: 24, w: 5, h: 8 },
  { i: 'watch',   x: 0,  y: 32, w: 2, h: 8 },
  { i: 'journal', x: 2,  y: 32, w: 4, h: 8 },
  { i: 'equity',  x: 6,  y: 32, w: 3, h: 8 },
  { i: 'stats',   x: 9,  y: 32, w: 3, h: 8 },
];

// 波段：權益曲線 / 績效 / 部位 / 日誌為主，DOM 縮為下方工具
const SWING_LG: GridItem[] = [
  { i: 'equity',  x: 0,  y: 0,  w: 5, h: 12 },
  { i: 'stats',   x: 0,  y: 12, w: 5, h: 10 },
  { i: 'pos',     x: 5,  y: 0,  w: 7, h: 9 },
  { i: 'journal', x: 5,  y: 9,  w: 7, h: 9 },
  { i: 'dom',     x: 0,  y: 22, w: 5, h: 14 },
  { i: 'chart',   x: 5,  y: 18, w: 7, h: 10 },
  { i: 'bal',     x: 0,  y: 36, w: 3, h: 7 },
  { i: 'watch',   x: 3,  y: 36, w: 2, h: 7 },
  { i: 'smart',   x: 5,  y: 36, w: 4, h: 7 },
  { i: 'hist',    x: 9,  y: 36, w: 2, h: 7 },
  { i: 'trade',   x: 11, y: 36, w: 1, h: 7 },
];

// 動能：focus mode 全螢幕 DOM/Chart（lg 留 daytrade 版面供退出 focus 後用）
export const LAYOUT_PRESETS: Record<Exclude<LayoutPresetId, 'custom'>, LayoutPreset> = {
  momentum: {
    label: '動能',
    desc: '專注模式全螢幕閃電下單 / K 線，零干擾追突破',
    focusMode: true,
    lg: DAYTRADE_LG,
  },
  daytrade: {
    label: '當沖',
    desc: 'DOM 大 + 帳務/部位即時可見，速度優先',
    focusMode: false,
    lg: DAYTRADE_LG,
  },
  swing: {
    label: '波段',
    desc: '權益曲線/績效/日誌為主，紀律導向',
    focusMode: false,
    lg: SWING_LG,
  },
};

export const PRESET_ORDER: LayoutPresetId[] = ['momentum', 'daytrade', 'swing', 'custom'];

export function presetLabel(id: LayoutPresetId): string {
  if (id === 'custom') return '自訂';
  return LAYOUT_PRESETS[id].label;
}
