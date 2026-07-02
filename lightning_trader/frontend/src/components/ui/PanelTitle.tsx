import React from 'react';

/**
 * PanelTitle — 面板標題列共用元件（架構整頓去重）
 *
 * 原本 7 個面板各自複製同一段「琥珀條 + 標題」的 <h3>。抽成單一元件，
 * 統一採 min-w-0 + truncate 版本（對原本沒 truncate 的面板無害，只在溢出時生效）。
 * 只負責標題文字本身，不含外層 header bar 與右側操作區——各面板保留自己的版位。
 */
const PanelTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2 min-w-0">
    <span className="w-1 h-3.5 bg-amber-500 rounded-full flex-shrink-0"></span>
    <span className="truncate">{children}</span>
  </h3>
);

export default PanelTitle;
