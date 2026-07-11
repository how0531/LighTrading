/**
 * HotkeyCheatSheet — `?` 觸發的快捷鍵速查表
 *
 * 來源：
 *   - 動態：SettingsContext.hotkeys（使用者可改的 Buy/Sell/CancelAll/Flatten/ScrollCenter）
 *   - 靜態：1-9 設口數、Shift+Click 加觸價、拖曳改單、? 開速查表
 *
 * 觸發：
 *   - 按 `?`（Shift+/）開
 *   - 按 Esc 或外部點擊關
 *   - 輸入框聚焦時 ? 不會誤觸發
 */
import React, { useEffect, useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';
import { acquireHotkeyBlock } from '../utils/hotkeyGate';

const ACTION_LABEL: Record<string, string> = {
  Buy:          '買進當前價',
  Sell:         '賣出當前價',
  CancelAll:    '全部刪單（兩側）',
  Flatten:      '一鍵平倉（先撤兩側）',
  ScrollCenter: 'DOM 捲到當前價',
  // UX 批次 4 Item 8
  ChaseBuy:     '追買（以賣一價掛買）',
  ChaseSell:    '追賣（以買一價掛賣）',
  MarketBuy:    '市價買進',
  MarketSell:   '市價賣出',
};

const STATIC_HOTKEYS: Array<{ keys: string; label: string }> = [
  { keys: '1 – 9',        label: '直接設定下單口數' },
  { keys: 'Shift + 點價',  label: '在該價位掛觸價單 (MIT)' },
  { keys: '拖曳掛單標籤', label: '改價（drop 到新價位）' },
  { keys: 'Esc',          label: '取消 modal / 全刪單（依 hotkey 設定）' },
  { keys: '?',            label: '開啟此速查表' },
];

const displayKey = (k: string): string => k === ' ' ? 'Space' : k;

export const HotkeyCheatSheet: React.FC = () => {
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isText = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (isText) return;
      // `?` 在多數鍵盤是 Shift+/，但有些 layout 直接是 ?
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // P0-1：速查表開啟時停用全域下單熱鍵（避免背後被 F1/a/s… 誤觸）。
  useEffect(() => {
    if (!open) return;
    return acquireHotkeyBlock();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg bg-[#1C2331] border border-[#29344A] rounded-xl shadow-2xl shadow-black/50 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 flex items-center justify-between px-4 border-b border-[#29344A]">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-[#D4AF37]" />
            <span className="text-sm font-bold text-white tracking-wide">快捷鍵</span>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors"
            title="關閉 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
          <section>
            <h3 className="text-[10px] font-bold text-[#D4AF37] uppercase tracking-widest mb-2">下單動作（可在「設定 → 快捷鍵」改）</h3>
            <ul className="space-y-1">
              {settings.hotkeys.map((hk, i) => (
                <li key={`${hk.action}-${i}`} className="flex items-center justify-between text-xs bg-white/5 rounded px-3 py-1.5 border border-white/5">
                  <span className="text-slate-300">{ACTION_LABEL[hk.action] || hk.action}</span>
                  <kbd className="px-2 py-0.5 bg-[#101623] border border-[#29344A] rounded text-[10px] font-mono text-[#D4AF37]">
                    {displayKey(hk.key)}
                  </kbd>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="text-[10px] font-bold text-[#D4AF37] uppercase tracking-widest mb-2">內建操作</h3>
            <ul className="space-y-1">
              {STATIC_HOTKEYS.map((h, i) => (
                <li key={i} className="flex items-center justify-between text-xs bg-white/5 rounded px-3 py-1.5 border border-white/5">
                  <span className="text-slate-300">{h.label}</span>
                  <kbd className="px-2 py-0.5 bg-[#101623] border border-[#29344A] rounded text-[10px] font-mono text-slate-200">
                    {h.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </section>
          <p className="text-[10px] text-slate-500 italic">
            * 在輸入框聚焦時這些快捷鍵不會觸發，可放心打字。
          </p>
        </div>
      </div>
    </div>
  );
};
