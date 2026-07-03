/**
 * ErrorBoundary — 包住 Dashboard / DOMPanel 的安全網
 *
 * 任何子元件 throw 不該讓整個交易畫面白屏。fallback UI 提供
 *   1. 簡明錯誤摘要
 *   2. 「重新載入」按鈕
 * 讓使用者能用最少步驟自救。
 */
import React from 'react';
import { AlertOctagon, RotateCcw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  label?: string;            // 用於區分多個 boundary（顯示在錯誤訊息中）
  compact?: boolean;         // 精簡 fallback：給 dashboard grid tile 用（單一面板掛掉不吃整頁）
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 把詳細資訊送到 console（不上報外部，避免外洩交易資料）
    console.error(`[ErrorBoundary:${this.props.label || 'app'}]`, error, info);
  }

  handleReset = () => this.setState({ hasError: false, error: null });
  handleReload = () => window.location.reload();

  render() {
    if (!this.state.hasError) return this.props.children;
    const msg = this.state.error?.message || '畫面渲染時發生例外';

    // 精簡版 fallback：塞得進 grid tile，其他面板照常運作
    if (this.props.compact) {
      return (
        <div className="flex-1 h-full min-h-0 flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border border-red-500/40 bg-red-950/20 text-red-200 text-center overflow-hidden">
          <AlertOctagon className="w-5 h-5 text-red-400 shrink-0" />
          <p className="text-xs font-bold">{this.props.label || '面板'} 發生例外</p>
          <p className="text-[10px] text-red-300/70 font-mono break-all line-clamp-2 max-w-full">{msg}</p>
          <div className="flex gap-1.5 mt-1">
            <button onClick={this.handleReset} className="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded text-[10px] font-bold transition-colors">
              重試
            </button>
            <button onClick={this.handleReload} className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded text-[10px] font-bold transition-colors flex items-center gap-1">
              <RotateCcw className="w-3 h-3" /> 重新載入
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="m-4 p-6 rounded-lg border border-red-500/50 bg-red-950/30 text-red-200 flex flex-col items-start gap-3 max-w-2xl">
        <div className="flex items-center gap-3">
          <AlertOctagon className="w-7 h-7 text-red-400" />
          <div>
            <h2 className="text-base font-bold">畫面發生例外：{this.props.label || '元件'}</h2>
            <p className="text-xs text-red-300/80 mt-1 font-mono break-all">{msg}</p>
          </div>
        </div>
        <p className="text-xs text-red-300/70">
          請先按「重試」嘗試還原。如果仍無法操作，按「重新載入」整頁刷新。
          交易單與持倉狀態會從後端重新拉取，不會遺失。
        </p>
        <div className="flex gap-2 mt-2">
          <button onClick={this.handleReset} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs font-bold transition-colors">
            重試
          </button>
          <button onClick={this.handleReload} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded text-xs font-bold transition-colors flex items-center gap-1">
            <RotateCcw className="w-3 h-3" /> 重新載入
          </button>
        </div>
      </div>
    );
  }
}
