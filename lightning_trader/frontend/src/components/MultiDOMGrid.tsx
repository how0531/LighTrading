/**
 * MultiDOMGrid — ⚡全開多 DOM 宮格（Sprint D）
 *
 * 全螢幕 overlay：把自選清單前 N 檔（4 / 6 / 9，UI 切 2×2 / 2×3 / 3×3）各開一個
 * MiniDOM。資料源＝TradingContext 的 bidAskBySymbol（完整五檔）＋ watchlistQuotes
 * （現價 / 漲跌%），皆為既有背景訂閱，開宮格不需要新訂閱（保險起見 mount 時
 * 仍呼叫一次 watchSymbols(settings.watchlist)——與 WatchlistPanel / QuoteBoardPanel
 * 同一份來源清單，等冪；覆蓋「專注模式下自選面板未掛載」的情境）。
 *
 * 互動：
 *   - 點格子買/賣側 → useMiniDomOrder（確認流含商品代碼 / 戰鬥模式直送 /
 *     409 風控 danger 重送 / 每商品獨立 in-flight 去重 / 下單音效）
 *   - 宮格層級共用「每筆口數」輸入
 *   - 每格右上「設為主商品」→ subscribe(sym)（同自選列點擊）並關閉宮格
 *     （UX 決策：設主商品的意圖就是回主 ladder 操作，留著宮格反而多一步 Esc）
 *   - Esc 關閉；開啟期間以 capture-phase keydown 吞掉其他按鍵，
 *     避免誤觸主 DOM 的全域下單熱鍵（比照 ConfirmContext 的攔截模式；
 *     ConfirmDialog 開啟時讓路，交給對話框自己的 Enter/Esc 處理）
 *   - 宮格開啟後移除自選 → 該格「已移除」灰態（symbol 列表取開啟當下快照）
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Zap } from 'lucide-react';
import { useQuotes, useTradingCore } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { useMiniDomOrder } from '../hooks/useMiniDomOrder';
import { symbolMatches } from '../utils/instrument';
import { MiniDOM } from './DOM/MiniDOM';
import { ConnectionBanner } from './ConnectionBanner';

// 單一商品報價「凍結」判定：距最後更新超過此毫秒數視為 stale（與後端 tick-stale 口徑相近）
const STALE_MS = 6_000;

const GRID_OPTIONS = [
  { n: 4, label: '2×2' },
  { n: 6, label: '2×3' },
  { n: 9, label: '3×3' },
] as const;

const gridColsCls = (n: number): string => (n === 4 ? 'grid-cols-2' : 'grid-cols-3');
const gridRowsCls = (n: number): string => (n === 9 ? 'grid-rows-3' : 'grid-rows-2');

interface MultiDOMGridProps {
  onClose: () => void;
}

const MultiDOMGrid: React.FC<MultiDOMGridProps> = ({ onClose }) => {
  const { watchlistQuotes, bidAskBySymbol } = useQuotes();
  const { targetSymbol, subscribe, watchSymbols, workingOrders, isConnected, isTickStale, brokerState } = useTradingCore();
  const { settings } = useSettings();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { placeFromGrid } = useMiniDomOrder();

  // P2：報價凍結判定需要「現在時間」隨時間推進 —— 每 2s tick 一次，驅動 stale 重算/重繪。
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);
  // WS 斷線 / 券商重連中 → 全宮格資料不可信（硬擋下單）
  const feedTrouble = !isConnected || brokerState === 'reconnecting' || brokerState === 'disconnected';

  const [gridN, setGridN] = useState<number>(4);
  const [qty, setQty] = useState<number>(1);
  // 開啟當下快照自選前 N 檔：之後清單變動不重排格子，被移除的顯示灰態
  const [gridSymbols, setGridSymbols] = useState<string[]>(
    () => settings.watchlist.slice(0, 4),
  );

  const applyGridN = (n: number) => {
    setGridN(n);
    setGridSymbols(settings.watchlist.slice(0, n));
  };

  // 保險訂閱：專注模式下 WatchlistPanel（lazy）可能從未掛載過 → 背景訂閱沒建立。
  // 與其餘面板同一份 settings.watchlist 來源，等冪呼叫不會互相覆蓋。
  useEffect(() => {
    watchSymbols(settings.watchlist);
  }, [settings.watchlist, watchSymbols]);

  // Esc 關閉 + 熱鍵攔截（capture）：宮格開啟時主 DOM 的全域下單熱鍵不得觸發。
  // ConfirmDialog（下單確認框）開啟時讓路——它自己有 capture 級 Enter/Esc 處理。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('[role="alertdialog"]')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // 其餘按鍵：擋掉 window bubble 的 DOMPanel 熱鍵（F1 買進 / 數字改口數…）；
      // 不 preventDefault，宮格內的輸入框照常打字
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // 每商品未成交委託數（workingOrders 已是 active-only 清單）
  const workingCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const sym of gridSymbols) {
      m[sym] = workingOrders.filter((o) => symbolMatches(sym, o.symbol)).length;
    }
    return m;
  }, [gridSymbols, workingOrders]);

  const liveList = settings.watchlist;

  // 單一商品是否 stale：連線層有問題（feedTrouble / 全域 tick-stale）或該商品報價逾時未更新
  const isSymbolStale = useCallback((sym: string): boolean => {
    if (feedTrouble || isTickStale) return true;
    const q = watchlistQuotes[sym];
    if (!q || !q.updatedAt) return false;
    return nowTs - q.updatedAt > STALE_MS;
  }, [feedTrouble, isTickStale, watchlistQuotes, nowTs]);

  const handlePlace = useCallback(async (sym: string, price: number, action: 'Buy' | 'Sell') => {
    // P2：斷線 / 券商重連中 → 宮格資料整體不可信，硬擋（避免對凍結盤口下單）
    if (feedTrouble) {
      toast.warn('連線異常（斷線／券商重連中），宮格暫停下單');
      return;
    }
    // 報價凍結（該商品逾時未更新或全域盤後無 tick）→ 至少 danger 確認
    if (isSymbolStale(sym)) {
      const ok = await confirm({
        title: '報價凍結',
        message: `${sym} 報價已停止更新，可能不是最新價。仍要以 ${price} 下單？`,
        confirmLabel: '仍要下單',
        danger: true,
      });
      if (!ok) return;
    }
    void placeFromGrid(sym, price, action, qty);
  }, [placeFromGrid, qty, feedTrouble, isSymbolStale, toast, confirm]);

  const handleSetPrimary = useCallback((sym: string) => {
    subscribe(sym);   // 與自選列點擊同路徑：setTargetSymbol + WS subscribe
    onClose();        // 設主商品的意圖是回主 ladder → 直接關閉宮格
  }, [subscribe, onClose]);

  return (
    <div
      className="fixed inset-0 z-[120] bg-[#0b101b]/95 backdrop-blur-sm flex flex-col p-4 gap-3"
      data-testid="multidom-overlay"
    >
      {/* P2：宮格頂部連線狀態列（複用 Dashboard 的 ConnectionBanner；正常時 return null 不佔位）。
          宮格是全螢幕 overlay 蓋掉了主畫面的連線燈，這裡補回狀態可見性。 */}
      <ConnectionBanner />

      {/* 工具列：標題 / 宮格尺寸 / 每筆口數 / 模式提示 / 關閉 */}
      <div className="shrink-0 flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg border border-slate-700/60 bg-[#151b26]">
        <h2 className="flex items-center gap-1.5 text-sm font-black tracking-widest text-[#D4AF37]">
          <Zap className="w-4 h-4" /> 全開 Multi-DOM
        </h2>

        <div className="flex items-center bg-[#101623] rounded border border-slate-700 overflow-hidden">
          {GRID_OPTIONS.map((opt) => (
            <button
              key={opt.n}
              onClick={() => applyGridN(opt.n)}
              className={`px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer ${
                gridN === opt.n ? 'bg-[#D4AF37] text-[#101623]' : 'text-slate-400 hover:text-slate-200'
              }`}
              title={`宮格 ${opt.label}（前 ${opt.n} 檔自選）`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">每筆口數</span>
          <div className="flex items-center bg-[#101623] rounded border border-slate-700 p-[1px]">
            <button
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="w-6 h-6 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors cursor-pointer text-sm font-black leading-none"
            >
              -
            </button>
            <input
              type="number"
              value={qty}
              min={1}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              aria-label="每筆口數"
              className="w-12 bg-transparent text-center text-[#D4AF37] text-[13px] font-black focus:outline-none tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button
              onClick={() => setQty((q) => q + 1)}
              className="w-6 h-6 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors cursor-pointer text-sm font-black leading-none"
            >
              +
            </button>
          </div>
        </div>

        <span className={`text-[10px] font-bold px-2 py-1 rounded border ${
          settings.isCombatMode
            ? 'text-red-300 border-red-700/60 bg-red-900/25'
            : 'text-slate-400 border-slate-700 bg-slate-800/50'
        }`}>
          {settings.isCombatMode ? '⚡ 戰鬥模式：點格即送單' : '防呆：下單需二次確認'}
        </span>

        <span className="ml-auto text-[10px] text-slate-500 hidden md:block">
          點買側=掛買 / 點賣側=掛賣（限價）· Esc 關閉 · 宮格開啟時主 DOM 熱鍵停用
        </span>
        <button
          onClick={onClose}
          className="p-1.5 rounded border border-slate-700 bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors cursor-pointer"
          title="關閉（Esc）"
          data-testid="multidom-close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 宮格本體 */}
      {gridSymbols.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
          自選清單為空——先到自選面板加入商品，再開啟全開宮格
        </div>
      ) : (
        <div className={`flex-1 min-h-0 grid gap-3 ${gridColsCls(gridN)} ${gridRowsCls(gridN)}`}>
          {gridSymbols.map((sym) => (
            <MiniDOM
              key={sym}
              symbol={sym}
              quote={watchlistQuotes[sym]}
              book={bidAskBySymbol[sym]}
              isTarget={sym === targetSymbol}
              workingCount={workingCounts[sym] || 0}
              removed={!liveList.includes(sym)}
              stale={isSymbolStale(sym)}
              onPlace={handlePlace}
              onSetPrimary={handleSetPrimary}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default MultiDOMGrid;
