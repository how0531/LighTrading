/* eslint-disable react-refresh/only-export-components --
 * Context 物件 / hooks 與 Provider 需同檔共享；改動本檔會整頁 HMR reload，可接受 */
import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { QuoteData, BidAskData } from '../types';
import { apiClient } from '../api/client';
import { resolveWsUrl } from '../utils/backendUrl';
import { computeLocalPnL } from '../utils/pnl';
import { useToast } from './ToastContext';

export interface AccountPosition {
  symbol: string; qty: number; direction: 'Buy' | 'Sell'; price: number; pnl: number; account?: string; raw_qty?: number;
}

// 即時損益持倉（含前端隨 tick 重算的 realtimePnl）
export interface RealtimePosition extends AccountPosition {
  realtimePnl: number;       // 前端即時計算的損益
  pnlPerUnit: number;        // 每口/每張盈虧點數
  currentPrice: number;      // 計算時使用的最新價
}


export interface AccountSummary {
  "當日交易": number; "參考損益": number; positions: AccountPosition[]; is_simulation?: boolean; active_stock?: string; active_future?: string; person_id?: string; msg_count?: number;
}
export interface AccountInfo {
  account_id: string; category: string; person_id: string; broker_id: string; account_name: string;
}
export interface WorkingOrder {
  symbol: string; action: 'Buy' | 'Sell'; price: number; qty: number; filled_qty: number; status: string; order_id?: string;
}
export interface SmartOrderData {
  id: string; symbol: string; order_type: string; action: string; qty: number;
  trigger_price: number; trigger_condition: string; trailing_offset: number;
  take_profit_price: number; stop_loss_price: number;
  is_active: boolean; is_triggered: boolean; created_at: string; triggered_at?: string;
}
// Sprint 12：watchlist 用的 mini quote（多 symbol 同時跑時不要塞整份 QuoteData）
export interface MiniQuote {
  symbol: string;
  price: number;
  reference: number;      // 0 = 還沒收到 snapshot
  high: number;
  low: number;
  updatedAt: number;      // local epoch ms
  // Sprint 34：報價看板需要的延伸欄位
  volume?: number;        // 自「開始訂閱」起累計的成交量；重連會歸零（後端 tick 只給單筆量，前端累加）
  bidPrice?: number;      // 第一檔委買價（背景商品的 BidAsk 也會廣播過來，這裡一併擷取）
  askPrice?: number;      // 第一檔委賣價
}

/**
 * 高頻 context — 100ms throttle flush 更新的 tick 資料。
 * 只有真的要跟著每筆報價重繪的元件（DOM ladder、K 線、逐筆、報價看板…）
 * 才透過 useQuotes() 訂閱，其餘面板不會被 10 次/秒的 flush 掃到。
 */
export interface QuotesContextType {
  quote: QuoteData | null;
  bidAsk: BidAskData | null;
  quoteHistory: QuoteData[];
  // Sprint 12：所有 watchlist + position 商品的最新 mini-quote（key = canonical symbol）
  watchlistQuotes: Record<string, MiniQuote>;
  // 即時損益（前端隨 tick 計算 + 後端 PnLUpdate 推播）
  realtimePositions: RealtimePosition[];
  totalRealtimePnl: number;
  totalRealizedPnl: number;
}

/**
 * 低頻 context — 連線狀態、帳戶、委託與所有 action 方法。
 * action 方法全部 useCallback 固定，value 只在低頻狀態真的變動時才換新。
 */
export interface TradingCoreContextType {
  isConnected: boolean;
  isStale: boolean;          // 任何訊息都沒收到（連線假死）
  isTickStale: boolean;      // 連線正常但沒 tick（盤後或商品冷門）
  targetSymbol: string; setTargetSymbol: (sym: string) => void;
  watchSymbols: (syms: string[]) => void;
  // Sprint 34：輔助訂閱來源（多圖看盤）。與 watchSymbols 的自選清單取聯集，
  // 兩者互不覆蓋，避免多圖把自選的背景訂閱洗掉。
  setAuxWatch: (syms: string[]) => void;
  accountSummary: AccountSummary; accounts: AccountInfo[]; activeAccount: string | null;
  workingOrders: WorkingOrder[]; setWorkingOrders: React.Dispatch<React.SetStateAction<WorkingOrder[]>>;
  refreshOrders: () => Promise<void>;
  /** 委託單同步的統一入口：leading-edge debounce（500ms），取代散落的 setTimeout(refreshOrders, …) */
  scheduleOrderRefresh: () => void;
  syncAll: () => Promise<void>;
  forceReconnect: () => void;
  subscribe: (symbol: string) => void; selectAccount: (accountId: string) => Promise<void>;
  cancelOrder: (action: 'Buy' | 'Sell', price?: number) => Promise<void>;
  flattenPosition: (symbol: string, cancelPending?: boolean) => Promise<void>;
  // 智慧單
  smartOrders: SmartOrderData[];
  refreshSmartOrders: (symbol?: string) => Promise<void>;
}

/** 合併型別（useTradingContext 回傳；既有 consumer 相容） */
export type TradingContextType = QuotesContextType & TradingCoreContextType;

// 匯出 context 物件本身供測試 stub 使用（一般程式請走 hooks）
export const QuotesContext = createContext<QuotesContextType | null>(null);
export const TradingCoreContext = createContext<TradingCoreContextType | null>(null);

const initialSummary: AccountSummary = { "當日交易": 0, "參考損益": 0, positions: [], is_simulation: true, msg_count: 0 };

// 委託清單內容相同就沿用舊 reference，避免 5s 輪詢每次都換新陣列打掛 memo
const sameOrders = (a: WorkingOrder[], b: WorkingOrder[]): boolean =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

const ORDER_REFRESH_DEBOUNCE_MS = 500;
const ORDER_POLL_INTERVAL_MS = 5000;

export const TradingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [isTickStale, setIsTickStale] = useState(false);
  const lastTickTimeRef = useRef<number>(0);      // mount 時補為 Date.now()（避免 render 期呼叫 impure）
  const isTickStaleRef = useRef<boolean>(false);
  const [targetSymbolState, setTargetSymbolState] = useState('2330');
  const targetSymbolRef = useRef('2330');

  const setTargetSymbol = useCallback((sym: string) => {
    setTargetSymbolState(sym);
    targetSymbolRef.current = sym;
  }, []);

  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [bidAsk, setBidAsk] = useState<BidAskData | null>(null);
  const [quoteHistory, setQuoteHistory] = useState<QuoteData[]>([]);
  const [accountSummary, setAccountSummary] = useState<AccountSummary>(initialSummary);
  const accountSummaryRef = useRef<AccountSummary>(initialSummary); // 用於即時損益計算，避免 setAccountSummary updater 反模式
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccount, setActiveAccount] = useState<string | null>(null);

  // 委託單狀態（部分由 WebSocket OrderUpdate 即時更新，部分由 REST 初始化）
  const [workingOrders, setWorkingOrders] = useState<WorkingOrder[]>([]);

  // 即時損益狀態（後端 WS PnLUpdate 推播）
  const [realtimePositions, setRealtimePositions] = useState<RealtimePosition[]>([]);
  const [totalRealtimePnl, setTotalRealtimePnl] = useState(0);
  const [totalRealizedPnl, setTotalRealizedPnl] = useState(0);
  // 智慧單狀態
  const [smartOrders, setSmartOrders] = useState<SmartOrderData[]>([]);
  // Sprint 12：watchlist mini-quotes — 100ms throttle 與主 quote 一起 flush
  const [watchlistQuotes, setWatchlistQuotes] = useState<Record<string, MiniQuote>>({});
  const watchlistDirtyRef = useRef<Record<string, MiniQuote>>({});
  const watchlistQuotesRef = useRef<Record<string, MiniQuote>>({}); // Sprint 34：mirror state，給 onmessage 跨 flush 讀累計值
  const watchSymbolsRef = useRef<Set<string>>(new Set());  // 聯集（給 onmessage 過濾 + onopen 重發）
  // Sprint 34：watch 訂閱拆成兩個來源，最終送後端的是聯集
  const primaryWatchRef = useRef<Set<string>>(new Set());  // 自選清單（WatchlistPanel / QuoteBoardPanel）
  const auxWatchRef = useRef<Set<string>>(new Set());      // 多圖看盤等輔助來源
  const watchRetryCountRef = useRef<number>(0);   // Sprint 12 R2：watch error ack retry 計數
  const watchRejectedRef = useRef<Set<string>>(new Set()); // R4：記住已警告過的 rejected，避免每次重連都重複 toast

  const refreshSmartOrders = useCallback(async (symbol?: string) => {
    try {
      const url = symbol ? `/smart_orders?symbol=${encodeURIComponent(symbol)}` : '/smart_orders';
      const res = await apiClient.get(url);
      setSmartOrders(res.data || []);
    } catch { /* 靜默 */ }
  }, []);

  // ★ 分流 Sequence：snapshot（REST 快照 + sync_all）與 callback（Shioaji 推播）
  // 兩條獨立 ref，避免一條被另一條的舊 seq 卡住
  const snapshotSeqRef = useRef<number>(0);
  const callbackSeqRef = useRef<number>(0);

  const refreshOrders = useCallback(async () => {
    try {
      const res = await apiClient.get('/order_history');
      const payload = res.data || {};
      const newSeq = payload.seq_no || 0;
      const historyList: WorkingOrder[] = payload.orders || [];

      if (newSeq >= snapshotSeqRef.current) {
        snapshotSeqRef.current = newSeq;
        const active = historyList.filter((o) =>
          o.status === 'PendingSubmit' || o.status === 'PreSubmitted' ||
          o.status === 'Submitted' || o.status === 'PartFilled'
        );
        setWorkingOrders((prev) => (sameOrders(prev, active) ? prev : active));
      }
    } catch { /* 靜默，維持舊狀態 */ }
  }, []);

  // ★ 委託單同步統一入口：leading-edge debounce。
  // 之前 OrderUpdate / TradeUpdate / 下單 / 刪單 各自 setTimeout(refreshOrders, 200~800)，
  // 活躍交易時會連環打 REST。改為：距上次同步 >500ms 立即執行，否則排一次 trailing。
  const orderRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastOrderRefreshAtRef = useRef(0);
  const scheduleOrderRefresh = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastOrderRefreshAtRef.current;
    if (elapsed >= ORDER_REFRESH_DEBOUNCE_MS) {
      lastOrderRefreshAtRef.current = now;
      void refreshOrders();
      return;
    }
    if (orderRefreshTimerRef.current) return; // 已有 trailing 排程
    orderRefreshTimerRef.current = setTimeout(() => {
      orderRefreshTimerRef.current = null;
      lastOrderRefreshAtRef.current = Date.now();
      void refreshOrders();
    }, ORDER_REFRESH_DEBOUNCE_MS - elapsed);
  }, [refreshOrders]);

  // 強制全量同步（給 reconnect / 使用者手動 sync）
  const syncAll = useCallback(async () => {
    try {
      const res = await apiClient.post('/sync_all');
      const payload = res.data || {};
      const newSeq = payload.seq_no || 0;
      if (newSeq >= snapshotSeqRef.current) {
        snapshotSeqRef.current = newSeq;
        const next: WorkingOrder[] = payload.working_orders || [];
        setWorkingOrders((prev) => (sameOrders(prev, next) ? prev : next));
      }
    } catch { /* 靜默；reconnect 時若失敗會自動重試 */ }
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(1000);
  const isUnmounted = useRef(false);
  const isSwitchingAccountRef = useRef(false);
  const lastMessageTimeRef = useRef<number>(0);   // mount 時補為 Date.now()
  const isStaleRef = useRef(false); // 避免 onmessage closure 中讀到舊值
  const wsAttemptCountRef = useRef(0); // 0=首次, 1+=重連
  const { toast } = useToast();

  // 穩定的 quote 緩衝區
  const latestQuoteRef = useRef<QuoteData | null>(null);
  const latestBidAskRef = useRef<BidAskData | null>(null);
  const quoteDirtyRef = useRef(false);   // 標記 quote 有新資料需同步
  const bidaskDirtyRef = useRef(false);   // 標記 bidask 有新資料需同步
  const pendingHistoryRef = useRef<QuoteData[]>([]);
  const pendingAccountRef = useRef<AccountSummary | null>(null);

  // 100ms 節流計時器：批次將 ref 中累積的資料同步到 React state
  useEffect(() => {
    const timer = setInterval(() => {
      if (quoteDirtyRef.current && latestQuoteRef.current) {
        quoteDirtyRef.current = false;
        const latestQ = { ...latestQuoteRef.current };
        setQuote(latestQ);

        // ★ 本地 PnL 重算抽到 utils/pnl.ts，方便單獨測試
        const latestPrice = latestQ.Price;
        if (latestPrice > 0) {
          const positions = accountSummaryRef.current.positions || [];
          const { positions: rtPositions, totalPnl } = computeLocalPnL(
            positions,
            latestPrice,
            targetSymbolRef.current,
          );
          setRealtimePositions(rtPositions);
          setTotalRealtimePnl(totalPnl);
        }
      }
      if (bidaskDirtyRef.current && latestBidAskRef.current) {
        bidaskDirtyRef.current = false;
        setBidAsk({ ...latestBidAskRef.current });
      }
      if (pendingHistoryRef.current.length > 0) {
        const batch = pendingHistoryRef.current;
        pendingHistoryRef.current = [];
        setQuoteHistory(prev => [...batch, ...prev].slice(0, 50));
      }
      if (pendingAccountRef.current !== null) {
        const summary = pendingAccountRef.current;
        pendingAccountRef.current = null;
        accountSummaryRef.current = summary; // 同步更新 ref（給即時損益計算用）
        setAccountSummary(summary);
        if (!isSwitchingAccountRef.current && summary.active_stock) {
          setActiveAccount(summary.active_stock);
        }
      }
      // Sprint 12：把累積的 watchlist 變動 flush 到 state（合併、不覆蓋）
      const dirtyKeys = Object.keys(watchlistDirtyRef.current);
      if (dirtyKeys.length > 0) {
        const updates = watchlistDirtyRef.current;
        watchlistDirtyRef.current = {};
        setWatchlistQuotes((prev) => {
          const next = { ...prev, ...updates };
          watchlistQuotesRef.current = next; // 同步 mirror，供下一批 tick 累加用
          return next;
        });
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // 雙重 stale watchdog
  //  - isStale     ：任何訊息都沒收到 > 8 秒（PnLUpdate 每 1.5s 心跳，超過代表連線假死）
  //  - isTickStale ：連線正常但 > 6 秒沒 Tick（盤後或商品冷門，不算錯誤但 UI 要降級）
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isConnected) {
        if (isStaleRef.current) { isStaleRef.current = false; setIsStale(false); }
        if (isTickStaleRef.current) { isTickStaleRef.current = false; setIsTickStale(false); }
        return;
      }
      const now = Date.now();
      const msgElapsed = now - lastMessageTimeRef.current;
      const tickElapsed = now - lastTickTimeRef.current;
      // 連線假死
      const wantStale = msgElapsed > 8000;
      if (wantStale !== isStaleRef.current) {
        isStaleRef.current = wantStale;
        setIsStale(wantStale);
      }
      // Tick 假死
      const wantTickStale = tickElapsed > 6000;
      if (wantTickStale !== isTickStaleRef.current) {
        isTickStaleRef.current = wantTickStale;
        setIsTickStale(wantTickStale);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isConnected]);

  // 防禦性合併 Quote（僅更新非零欄位，保留 Snapshot 靜態資料）
  const mergeQuote = useCallback((incoming: Partial<QuoteData>) => {
    const prev = latestQuoteRef.current;
    const newPrice = (incoming.Price != null && incoming.Price > 0)
      ? incoming.Price : (prev?.Price ?? 0);
    if (newPrice === 0) return; // 跳過無效 tick

    const merged: QuoteData = {
      Symbol: incoming.Symbol ?? prev?.Symbol ?? targetSymbolRef.current,
      Price: newPrice,
      Volume: incoming.Volume ?? prev?.Volume ?? 0,
      Open: (incoming.Open && incoming.Open > 0) ? incoming.Open : prev?.Open,
      High: (incoming.High && incoming.High > 0) ? incoming.High : prev?.High,
      Low: (incoming.Low && incoming.Low > 0) ? incoming.Low : prev?.Low,
      AvgPrice: incoming.AvgPrice ?? prev?.AvgPrice,
      Reference: (incoming.Reference && incoming.Reference > 0) ? incoming.Reference : prev?.Reference,
      LimitUp: (incoming.LimitUp && incoming.LimitUp > 0) ? incoming.LimitUp : prev?.LimitUp,
      LimitDown: (incoming.LimitDown && incoming.LimitDown > 0) ? incoming.LimitDown : prev?.LimitDown,
      TickTime: incoming.TickTime ?? prev?.TickTime ?? '',
      TickType: incoming.TickType ?? prev?.TickType,
      Action: incoming.Action ?? prev?.Action ?? '',
    };
    latestQuoteRef.current = merged;
    quoteDirtyRef.current = true;
    pendingHistoryRef.current.push(merged);
  }, []);

  // WebSocket 連線管理 — 定義為 ref 函式避免 useEffect 依賴問題。
  // ref 寫入放在 effect（每次 render 後刷新 closure；render 期間不可寫 ref）。
  const connectWsRef = useRef<() => void>(() => { });
  useEffect(() => {
  connectWsRef.current = () => {
    if (isUnmounted.current) return;
    // 如果已經有活躍連線，不要重複建立
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

    // URL 解析共用 utils/backendUrl（與 api/client 同一套 host 邏輯；含選配 ?token=）
    const ws = new WebSocket(resolveWsUrl());

    ws.onopen = () => {
      if (isUnmounted.current) { ws.close(); return; }
      setIsConnected(true);
      reconnectDelayRef.current = 1000;
      const sym = targetSymbolRef.current;
      ws.send(JSON.stringify({ action: 'subscribe', symbol: sym }));
      console.info(`[WS] 連線成功，訂閱 ${sym}`);
      lastMessageTimeRef.current = Date.now();
      // Sprint 12 R2：重發 watchlist。backend 不持久化 subscribe_background，
      // 斷線重連會丟掉所有 watch 訂閱；ws.onopen 主動補回。
      const watched = Array.from(watchSymbolsRef.current);
      if (watched.length > 0) {
        ws.send(JSON.stringify({ action: 'watch', symbols: watched }));
        console.info(`[WS] 重發 watchlist (${watched.length})`);
      }
      // ★ 重連後立即強制三合一同步：確保斷線期間外部下單的單也會出現
      syncAll();
      // 區分首次連線 vs 重連：重連時主動告知使用者「已重新連線」
      wsAttemptCountRef.current += 1;
      if (wsAttemptCountRef.current > 1) {
        toast.success('已重新連線到交易引擎');
      }
    };

    ws.onmessage = (event) => {
      try {
        lastMessageTimeRef.current = Date.now();
        if (isStaleRef.current) { isStaleRef.current = false; setIsStale(false); }

        const data = JSON.parse(event.data);
        const isMatch = (payload: { Symbol?: unknown } | null | undefined): boolean => {
          if (!payload?.Symbol) return true;
          const sym = String(payload.Symbol).trim().toUpperCase();
          const target = targetSymbolRef.current.trim().toUpperCase();
          return sym === target;
        };

        if (data.type === 'Tick' && data.data) {
          if (isMatch(data.data)) {
            // target 商品的 Tick 進主流程
            lastTickTimeRef.current = Date.now();
            mergeQuote(data.data as Partial<QuoteData>);
          }
          // Sprint 12：所有 Tick（含 target）都更新 watchlistDirtyRef，讓 watchlist panel 拿到報價
          const tickSym = String(data.data.Symbol || '').trim().toUpperCase();
          const tickPrice = Number(data.data.Price || 0);
          if (tickSym && tickPrice > 0 && watchSymbolsRef.current.has(tickSym)) {
            // 先看 dirty 緩衝，再 fallback 到已 flush 的 state，確保 volume 累加跨 flush 不歸零
            const existing = watchlistDirtyRef.current[tickSym] || watchlistQuotesRef.current[tickSym] || {
              symbol: tickSym, price: 0,
              reference: Number(data.data.Reference || 0),
              high: 0, low: 0, updatedAt: 0, volume: 0,
            };
            const ref = Number(data.data.Reference || 0) || existing.reference;
            const high = Number(data.data.High || 0) || existing.high || tickPrice;
            const low  = Number(data.data.Low || 0)  || existing.low  || tickPrice;
            // Sprint 34：後端 tick.Volume 是單筆量，累加成「本場累計量」（重連歸零，已於 UI 標註）
            const tickVol = Number(data.data.Volume || 0);
            watchlistDirtyRef.current[tickSym] = {
              ...existing,
              symbol: tickSym,
              price: tickPrice,
              reference: ref,
              high: Math.max(high, tickPrice),
              low: Math.min(low || tickPrice, tickPrice),
              volume: (existing.volume || 0) + (tickVol > 0 ? tickVol : 0),
              updatedAt: Date.now(),
            };
          }
        } else if (data.type === 'BidAsk' && data.data) {
          if (isMatch(data.data)) {
            latestBidAskRef.current = data.data as BidAskData;
            bidaskDirtyRef.current = true;
          }
          // Sprint 34：背景商品的 BidAsk 也會被全廣播過來，擷取第一檔買/賣價給報價看板
          const baSym = String(data.data.Symbol || '').trim().toUpperCase();
          if (baSym && watchSymbolsRef.current.has(baSym)) {
            const bid = Array.isArray(data.data.BidPrice) ? Number(data.data.BidPrice[0] || 0) : 0;
            const ask = Array.isArray(data.data.AskPrice) ? Number(data.data.AskPrice[0] || 0) : 0;
            if (bid > 0 || ask > 0) {
              const existing = watchlistDirtyRef.current[baSym] || watchlistQuotesRef.current[baSym] || {
                symbol: baSym, price: 0, reference: 0, high: 0, low: 0, updatedAt: 0,
              };
              watchlistDirtyRef.current[baSym] = {
                ...existing,
                symbol: baSym,
                bidPrice: bid > 0 ? bid : existing.bidPrice,
                askPrice: ask > 0 ? ask : existing.askPrice,
                updatedAt: Date.now(),
              };
            }
          }
        } else if (data.type === 'AccountUpdate' && data.data) {
          pendingAccountRef.current = data.data;
        } else if (data.type === 'PnLUpdate' && data.data) {
          // ★ 後端即時 PnL 推播：直接更新 state（後端已計算好所有持倉）
          const { positions: rtPos, total_pnl, total_realized } = data.data;
          setRealtimePositions((rtPos as RealtimePosition[]) || []);
          setTotalRealtimePnl(total_pnl ?? 0);
          if (total_realized !== undefined) setTotalRealizedPnl(total_realized);
        } else if (data.type === 'OrderUpdate' && data.data) {
          // Shioaji order_callback 推送 → 比較 callback seq，獨立於 snapshot seq
          const incSeq = data.seq_no || 0;
          if (incSeq >= callbackSeqRef.current) {
             callbackSeqRef.current = incSeq;
             scheduleOrderRefresh();
          }
        } else if (data.type === 'WorkingOrdersSnapshot' && data.data) {
          // 後端委託對帳迴圈主動推播（外部管道下的單也會即時出現）——
          // 直接套用快照，不必再打 REST；沿用 snapshot seq 防亂序
          const incSeq = data.seq_no || 0;
          if (incSeq >= snapshotSeqRef.current) {
            snapshotSeqRef.current = incSeq;
            const next: WorkingOrder[] = data.data.orders || [];
            setWorkingOrders((prev) => (sameOrders(prev, next) ? prev : next));
          }
        } else if (data.type === 'SmartOrderUpdate' && data.data) {
          // 智慧單狀態更新（新增/觸發/已取消）
          setSmartOrders(prev => {
            const incoming: SmartOrderData = data.data;
            const idx = prev.findIndex(o => o.id === incoming.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = incoming;
              return next.filter(o => o.is_active);
            }
            return incoming.is_active ? [...prev, incoming] : prev;
          });
        } else if (data.type === 'TradeUpdate' && data.data) {
          // 成交回報也觸發一次 REST 同步，確保填協數量正確
          scheduleOrderRefresh();
        } else if (data.action === 'subscribe' && data.status === 'success') {
          if (data.symbol) setTargetSymbol(data.symbol);
        } else if (data.action === 'watch' && data.status === 'error') {
          // Sprint 12 R2：backend 還沒登入 → 3 秒後 retry 一次（最多 5 次）
          if (watchRetryCountRef.current < 5 && watchSymbolsRef.current.size > 0) {
            watchRetryCountRef.current += 1;
            setTimeout(() => {
              const wsNow = wsRef.current;
              if (wsNow && wsNow.readyState === WebSocket.OPEN) {
                wsNow.send(JSON.stringify({
                  action: 'watch',
                  symbols: Array.from(watchSymbolsRef.current),
                }));
              }
            }, 3000);
          }
        } else if (data.action === 'watch' && data.status === 'success') {
          // 成功了就重置 retry 計數
          watchRetryCountRef.current = 0;
          // Sprint 12 R4：被拒絕的 symbol 提示使用者，但只在第一次警告
          // —— 重連、自動 retry、UI re-render 都不該重複跳 toast 騷擾。
          const rejected = Array.isArray(data.rejected) ? data.rejected as string[] : [];
          const newRejected = rejected.filter((s) => !watchRejectedRef.current.has(s));
          if (newRejected.length > 0) {
            newRejected.forEach((s) => watchRejectedRef.current.add(s));
            toast.warn(`自選清單忽略 ${newRejected.length} 個無效商品：${newRejected.join(', ')}`);
          }
          // 同時把已成功訂閱的 symbol 從「已警告」集合移除（給使用者修正後重新試的可能）
          if (Array.isArray(data.symbols)) {
            for (const s of data.symbols as string[]) watchRejectedRef.current.delete(s);
          }
        }
      } catch (err) { console.error('[WS error]', err); }
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (isUnmounted.current) return;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, 30000);
      // ±20% 隨機 jitter：多分頁 / 多視窗同時斷線時錯開重連風暴
      const jitter = 0.8 + Math.random() * 0.4;
      setTimeout(() => connectWsRef.current(), Math.round(delay * jitter));
    };

    wsRef.current = ws;
  };
  });

  // 空依賴 useEffect — 只在 mount 時建立一次 WebSocket（StrictMode 安全）
  useEffect(() => {
    isUnmounted.current = false;
    // watchdog 基準時間補值（useRef 初始器不能呼叫 Date.now）
    lastMessageTimeRef.current = Date.now();
    lastTickTimeRef.current = Date.now();
    // 延遲 50ms 建立連線，讓 StrictMode 的第一次 cleanup 先執行完
    const timerId = setTimeout(() => connectWsRef.current(), 50);
    return () => {
      clearTimeout(timerId);
      isUnmounted.current = true;
      if (orderRefreshTimerRef.current) {
        clearTimeout(orderRefreshTimerRef.current);
        orderRefreshTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    apiClient.get('/accounts').then(res => {
      setAccounts(res.data);
      if (res.data.length > 0) {
        const first = `${res.data[0].broker_id}-${res.data[0].account_id}`;
        setActiveAccount(prev => prev ?? first);
      }
    }).catch(e => console.error(e));
    // 連線成功後立即擷取現有活躍委託單（下一個 tick 執行，effect 本體不直接觸發 setState）
    const kickoffTimer = setTimeout(scheduleOrderRefresh, 0);

    // ★ 關鍵：Shioaji 原廠 API 不會主動推送「在其他平台下單」的 WebSocket 廣播。
    // 為了做到「外部下單，此畫面亦能絕對同步」，必須加上背景輪詢（5s 慢速；
    // 即時性靠 OrderUpdate / TradeUpdate → scheduleOrderRefresh 補足）。
    const orderSyncTimer = setInterval(scheduleOrderRefresh, ORDER_POLL_INTERVAL_MS);
    return () => {
      clearTimeout(kickoffTimer);
      clearInterval(orderSyncTimer);
    };
  }, [isConnected, scheduleOrderRefresh]);

  const selectAccount = useCallback(async (fullId: string) => {
    setActiveAccount(fullId);
    isSwitchingAccountRef.current = true;
    try {
      await apiClient.post('/set_active_account', { account_id: fullId });
      setTimeout(() => { isSwitchingAccountRef.current = false; }, 2000);
    } catch (err) { console.error('[TradingContext] 帳號切換失敗:', err); isSwitchingAccountRef.current = false; }
  }, []);

  // Sprint 12 / 34：watchlist 訂閱 — primary(自選) 與 aux(多圖) 取聯集後送後端
  // ref 是給 onmessage handler 過濾用；WS 訊息是給後端 subscribe_background
  const applyWatch = useCallback(() => {
    const union = new Set<string>([...primaryWatchRef.current, ...auxWatchRef.current]);
    watchSymbolsRef.current = union;
    // 移除掉不再 watch 的 symbol（舊資料留著會佔記憶體 + UI 顯示舊價）
    setWatchlistQuotes((prev) => {
      const next: Record<string, MiniQuote> = {};
      for (const s of union) {
        if (prev[s]) next[s] = prev[s];
      }
      watchlistQuotesRef.current = next;
      return next;
    });
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && union.size > 0) {
      ws.send(JSON.stringify({ action: 'watch', symbols: Array.from(union) }));
    }
  }, []);

  const watchSymbols = useCallback((syms: string[]) => {
    primaryWatchRef.current = new Set(
      syms.map((s) => (s || '').trim().toUpperCase()).filter(Boolean),
    );
    applyWatch();
  }, [applyWatch]);

  // Sprint 34：多圖看盤等輔助來源呼叫，與自選清單聯集，不互相覆蓋
  const setAuxWatch = useCallback((syms: string[]) => {
    auxWatchRef.current = new Set(
      syms.map((s) => (s || '').trim().toUpperCase()).filter(Boolean),
    );
    applyWatch();
  }, [applyWatch]);

  const forceReconnect = useCallback(() => {
    // 立即關閉現有 socket 並觸發重連（不等指數退避）
    reconnectDelayRef.current = 500;
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(); } catch { /* noop */ }
    }
    // ws.onclose 會排下一次重連，這邊保險再戳一次
    setTimeout(() => connectWsRef.current(), 100);
  }, []);

  const subscribe = useCallback((symbol: string) => {
    const trimmed = symbol.trim().toUpperCase();
    if (!trimmed) return;

    setTargetSymbol(trimmed);
    setQuoteHistory([]);
    setQuote(null);
    latestQuoteRef.current = null;
    latestBidAskRef.current = null;
    setBidAsk(null);
    pendingHistoryRef.current = [];

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'subscribe', symbol: trimmed }));
      console.info(`[WS] 訂閱 ${trimmed}`);
    } else {
      console.warn('[WS] 未連線，嘗試重連...');
      connectWsRef.current();
    }
  }, [setTargetSymbol]);

  const cancelOrder = useCallback(async (action: 'Buy' | 'Sell', price?: number) => {
    try {
      const res = await apiClient.post('/cancel_all', {
        symbol: targetSymbolRef.current,
        action,
        ...(price !== undefined && { price })
      });
      const payload = res.data?.data || {};
      const newSeq = payload.seq_no || 0;
      if (newSeq >= snapshotSeqRef.current) {
        snapshotSeqRef.current = newSeq;
        setWorkingOrders(payload.orders || []);
      }
    } catch (err) {
      console.error('Cancel order failed:', err);
    }
  }, []);

  const flattenPosition = useCallback(async (symbol: string, cancelPending: boolean = true) => {
    try {
      await apiClient.post('/flatten', { symbol, cancel_pending: cancelPending });
      scheduleOrderRefresh();
    } catch (err) {
      console.error('Flatten position failed:', err);
    }
  }, [scheduleOrderRefresh]);

  // ── Context values ──────────────────────────────────────────────
  // 高頻：100ms flush 更新的 tick 資料
  const quotesValue = useMemo<QuotesContextType>(() => ({
    quote, bidAsk, quoteHistory, watchlistQuotes,
    realtimePositions, totalRealtimePnl, totalRealizedPnl,
  }), [quote, bidAsk, quoteHistory, watchlistQuotes, realtimePositions, totalRealtimePnl, totalRealizedPnl]);

  // 低頻：連線 / 帳戶 / 委託 + 全部 action（action 皆 useCallback，value 很少換新）
  const coreValue = useMemo<TradingCoreContextType>(() => ({
    isConnected, isStale, isTickStale,
    targetSymbol: targetSymbolState, setTargetSymbol,
    watchSymbols, setAuxWatch,
    accountSummary, accounts, activeAccount,
    workingOrders, setWorkingOrders, refreshOrders, scheduleOrderRefresh, syncAll, forceReconnect,
    subscribe, selectAccount, cancelOrder, flattenPosition,
    smartOrders, refreshSmartOrders,
  }), [
    isConnected, isStale, isTickStale, targetSymbolState, setTargetSymbol,
    watchSymbols, setAuxWatch, accountSummary, accounts, activeAccount,
    workingOrders, refreshOrders, scheduleOrderRefresh, syncAll, forceReconnect,
    subscribe, selectAccount, cancelOrder, flattenPosition,
    smartOrders, refreshSmartOrders,
  ]);

  return (
    <TradingCoreContext.Provider value={coreValue}>
      <QuotesContext.Provider value={quotesValue}>
        {children}
      </QuotesContext.Provider>
    </TradingCoreContext.Provider>
  );
};

/** 高頻 hook：只給真的要吃 tick 的元件（DOM / Chart / 逐筆 / 報價看板…） */
export const useQuotes = (): QuotesContextType => {
  const context = useContext(QuotesContext);
  if (!context) throw new Error('useQuotes must be used within a TradingProvider');
  return context;
};

/** 低頻 hook：連線狀態、帳戶、委託與 action 方法（不會被 100ms flush 掃到） */
export const useTradingCore = (): TradingCoreContextType => {
  const context = useContext(TradingCoreContext);
  if (!context) throw new Error('useTradingCore must be used within a TradingProvider');
  return context;
};

/**
 * 向後相容 hook：合併高低頻兩個 context。
 * 注意：訂閱本 hook 的元件會跟著每次 quote flush 重繪，
 * 不需要 tick 資料的元件請改用 useTradingCore()（或 useQuotes()）。
 */
export const useTradingContext = (): TradingContextType => {
  const core = useTradingCore();
  const quotes = useQuotes();
  return useMemo(() => ({ ...core, ...quotes }), [core, quotes]);
};
