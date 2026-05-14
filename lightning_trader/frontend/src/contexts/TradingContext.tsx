import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import type { QuoteData, BidAskData } from '../types';
import { apiClient } from '../api/client';
import { computeLocalPnL } from '../utils/pnl';
import { useToast } from './ToastContext';

interface AccountPosition {
  symbol: string; qty: number; direction: 'Buy' | 'Sell'; price: number; pnl: number; account?: string; raw_qty?: number;
}

// 即時損益持倉（含前端隨 tick 重算的 realtimePnl）
export interface RealtimePosition extends AccountPosition {
  realtimePnl: number;       // 前端即時計算的損益
  pnlPerUnit: number;        // 每口/每張盈虧點數
  currentPrice: number;      // 計算時使用的最新價
}


interface AccountSummary {
  "當日交易": number; "參考損益": number; positions: AccountPosition[]; is_simulation?: boolean; active_stock?: string; active_future?: string; person_id?: string; msg_count?: number;
}
interface AccountInfo {
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
interface TradingContextType {
  isConnected: boolean;
  isStale: boolean;          // 任何訊息都沒收到（連線假死）
  isTickStale: boolean;      // 連線正常但沒 tick（盤後或商品冷門）
  targetSymbol: string; setTargetSymbol: (sym: string) => void;
  quote: QuoteData | null; bidAsk: BidAskData | null; quoteHistory: QuoteData[];
  accountSummary: AccountSummary; accounts: AccountInfo[]; activeAccount: string | null;
  workingOrders: WorkingOrder[]; setWorkingOrders: React.Dispatch<React.SetStateAction<WorkingOrder[]>>; refreshOrders: () => Promise<void>;
  syncAll: () => Promise<void>;
  forceReconnect: () => void;
  subscribe: (symbol: string) => void; selectAccount: (accountId: string) => Promise<void>;
  cancelOrder: (action: 'Buy' | 'Sell', price?: number) => Promise<void>;
  flattenPosition: (symbol: string, cancelPending?: boolean) => Promise<void>;
  // 即時損益（前端隨 tick 計算）
  realtimePositions: RealtimePosition[];
  totalRealtimePnl: number;
  totalRealizedPnl: number;
  // 智慧單
  smartOrders: SmartOrderData[];
  refreshSmartOrders: (symbol?: string) => Promise<void>;
}

const TradingContext = createContext<TradingContextType | null>(null);
const initialSummary: AccountSummary = { "當日交易": 0, "參考損益": 0, positions: [], is_simulation: true, msg_count: 0 };

export const TradingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [isTickStale, setIsTickStale] = useState(false);
  const lastTickTimeRef = useRef<number>(Date.now());
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
      const historyList = payload.orders || [];

      if (newSeq >= snapshotSeqRef.current) {
        snapshotSeqRef.current = newSeq;
        const active: WorkingOrder[] = historyList.filter((o: any) =>
          o.status === 'PendingSubmit' || o.status === 'PreSubmitted' ||
          o.status === 'Submitted' || o.status === 'PartFilled'
        );
        setWorkingOrders(active);
      }
    } catch { /* 靜默，維持舊狀態 */ }
  }, []);

  // 強制全量同步（給 reconnect / 使用者手動 sync）
  const syncAll = useCallback(async () => {
    try {
      const res = await apiClient.post('/sync_all');
      const payload = res.data || {};
      const newSeq = payload.seq_no || 0;
      if (newSeq >= snapshotSeqRef.current) {
        snapshotSeqRef.current = newSeq;
        setWorkingOrders(payload.working_orders || []);
      }
    } catch { /* 靜默；reconnect 時若失敗會自動重試 */ }
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(1000);
  const isUnmounted = useRef(false);
  const isSwitchingAccountRef = useRef(false);
  const lastMessageTimeRef = useRef<number>(Date.now());
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

  // WebSocket 連線管理 — 定義為 ref 函式避免 useEffect 依賴問題
  const connectWsRef = useRef<() => void>(() => { });
  connectWsRef.current = () => {
    if (isUnmounted.current) return;
    // 如果已經有活躍連線，不要重複建立
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

    // 與 /api 相同策略：用 same-origin，由 vite dev proxy 或 nginx 轉發到 backend。
    // https 站台自動升級成 wss。
    const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsScheme}://${window.location.host}/ws/quotes`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (isUnmounted.current) { ws.close(); return; }
      setIsConnected(true);
      reconnectDelayRef.current = 1000;
      const sym = targetSymbolRef.current;
      ws.send(JSON.stringify({ action: 'subscribe', symbol: sym }));
      console.log(`[WS] 連線成功，訂閱 ${sym}`);
      lastMessageTimeRef.current = Date.now();
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
        const isMatch = (payload: any): boolean => {
          if (!payload?.Symbol) return true;
          const sym = String(payload.Symbol).trim().toUpperCase();
          const target = targetSymbolRef.current.trim().toUpperCase();
          return sym === target;
        };

        if (data.type === 'Tick' && data.data && isMatch(data.data)) {
          lastTickTimeRef.current = Date.now();
          mergeQuote(data.data as Partial<QuoteData>);
        } else if (data.type === 'BidAsk' && data.data) {
          if (isMatch(data.data)) {
            latestBidAskRef.current = data.data as BidAskData;
            bidaskDirtyRef.current = true;
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
             setTimeout(refreshOrders, 500);
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
          setTimeout(refreshOrders, 800);
        } else if (data.action === 'subscribe' && data.status === 'success') {
          if (data.symbol) setTargetSymbol(data.symbol);
        }
      } catch (err) { console.error('[WS error]', err); }
    };

    ws.onclose = () => {
      setIsConnected(false);
      if (isUnmounted.current) return;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, 30000);
      setTimeout(() => connectWsRef.current(), delay);
    };

    wsRef.current = ws;
  };

  // 空依賴 useEffect — 只在 mount 時建立一次 WebSocket（StrictMode 安全）
  useEffect(() => {
    isUnmounted.current = false;
    // 延遲 100ms 建立連線，讓 StrictMode 的第一次 cleanup 先執行完
    const timerId = setTimeout(() => connectWsRef.current(), 50);
    return () => {
      clearTimeout(timerId);
      isUnmounted.current = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isConnected) {
      apiClient.get('/accounts').then(res => {
        setAccounts(res.data);
        if (res.data.length > 0 && !activeAccount) {
          setActiveAccount(`${res.data[0].broker_id}-${res.data[0].account_id}`);
        }
      }).catch(e => console.error(e));
      // 連線成功後立即擷取現有活躍委託單
      refreshOrders();

      // ★ 關鍵：Shioaji 原廠 API 不會主動推送「在其他平台下單」的 WebSocket 廣播。
      // 為了做到「外部下單，此畫面亦能絕對同步」，必須加上定時輪詢。
      // 每 2 秒強制去接一次 REST API，後端 API 內已經加上了 update_status 去強迫券商主機更新。
      const orderSyncTimer = setInterval(refreshOrders, 2000);
      return () => clearInterval(orderSyncTimer);
    }
  }, [isConnected, refreshOrders]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectAccount = useCallback(async (fullId: string) => {
    setActiveAccount(fullId);
    isSwitchingAccountRef.current = true;
    try {
      await apiClient.post('/set_active_account', { account_id: fullId });
      setTimeout(() => { isSwitchingAccountRef.current = false; }, 2000);
    } catch (err) { console.error('[TradingContext] 帳號切換失敗:', err); isSwitchingAccountRef.current = false; }
  }, []);

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
      console.log(`[WS] 訂閱 ${trimmed}`);
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
      setTimeout(refreshOrders, 500);
    } catch (err) {
      console.error('Flatten position failed:', err);
    }
  }, [refreshOrders]);

  return (
    <TradingContext.Provider value={{
      isConnected, isStale, isTickStale, targetSymbol: targetSymbolState, setTargetSymbol,
      quote, bidAsk, quoteHistory, accountSummary, accounts, activeAccount,
      workingOrders, setWorkingOrders, refreshOrders, syncAll, forceReconnect,
      subscribe, selectAccount,
      cancelOrder, flattenPosition,
      realtimePositions, totalRealtimePnl, totalRealizedPnl,
      smartOrders, refreshSmartOrders,
    }}>
      {children}
    </TradingContext.Provider>
  );
};

export const useTradingContext = () => {
  const context = useContext(TradingContext);
  if (!context) throw new Error('useTradingContext must be used within a TradingProvider');
  return context;
};
