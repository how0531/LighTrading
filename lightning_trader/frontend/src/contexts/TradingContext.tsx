import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import type { QuoteData, BidAskData } from '../types';
import { apiClient } from '../api/client';

interface AccountPosition {
  symbol: string; qty: number; direction: 'Buy' | 'Sell'; price: number; pnl: number; account?: string; raw_qty?: number;
}
interface AccountSummary {
  "當日交易": number; "參考損益": number; positions: AccountPosition[]; is_simulation?: boolean; active_stock?: string; active_future?: string; person_id?: string; msg_count?: number;
}
interface AccountInfo {
  account_id: string; category: string; person_id: string; broker_id: string; account_name: string;
}
interface TradingContextType {
  isConnected: boolean; isStale: boolean; targetSymbol: string; setTargetSymbol: (sym: string) => void;
  quote: QuoteData | null; bidAsk: BidAskData | null; quoteHistory: QuoteData[];
  accountSummary: AccountSummary; accounts: AccountInfo[]; activeAccount: string | null;
  subscribe: (symbol: string) => void; selectAccount: (accountId: string) => Promise<void>;
}

const TradingContext = createContext<TradingContextType | null>(null);
const initialSummary: AccountSummary = { "當日交易": 0, "參考損益": 0, positions: [], is_simulation: true, msg_count: 0 };

export const TradingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isStale, setIsStale] = useState(false);
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
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccount, setActiveAccount] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(1000);
  const isUnmounted = useRef(false);
  const isSwitchingAccountRef = useRef(false);
  const lastMessageTimeRef = useRef<number>(Date.now());

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
        setQuote({ ...latestQuoteRef.current });
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
        setAccountSummary(summary);
        if (!isSwitchingAccountRef.current && summary.active_stock) {
          setActiveAccount(summary.active_stock);
        }
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // 檢查是否假死 (Stale) - 每秒檢查一次
  useEffect(() => {
    const timer = setInterval(() => {
      // 只有在已連線的狀態下才判斷是否假死
      if (!isConnected) {
        if (isStale) setIsStale(false);
        return;
      }
      const elapsed = Date.now() - lastMessageTimeRef.current;
      if (elapsed > 5000 && !isStale) {
        setIsStale(true);
      } else if (elapsed <= 5000 && isStale) {
        setIsStale(false);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isConnected, isStale]);

  // 防禦性合併 Quote（僅更新非零欄位，保留 Snapshot 靜態資料）
  const mergeQuote = useCallback((incoming: Partial<QuoteData>) => {
    const prev = latestQuoteRef.current;
    const newPrice = (incoming.Price != null && incoming.Price > 0)
      ? incoming.Price : (prev?.Price ?? 0);
    if (newPrice === 0) return; // 跳過無效 tick

    const merged: QuoteData = {
      Symbol:    incoming.Symbol    ?? prev?.Symbol    ?? targetSymbolRef.current,
      Price:     newPrice,
      Volume:    incoming.Volume    ?? prev?.Volume    ?? 0,
      Open:      (incoming.Open    && incoming.Open    > 0) ? incoming.Open    : prev?.Open,
      High:      (incoming.High    && incoming.High    > 0) ? incoming.High    : prev?.High,
      Low:       (incoming.Low     && incoming.Low     > 0) ? incoming.Low     : prev?.Low,
      AvgPrice:  incoming.AvgPrice  ?? prev?.AvgPrice,
      Reference: (incoming.Reference && incoming.Reference > 0) ? incoming.Reference : prev?.Reference,
      LimitUp:   (incoming.LimitUp   && incoming.LimitUp   > 0) ? incoming.LimitUp   : prev?.LimitUp,
      LimitDown: (incoming.LimitDown && incoming.LimitDown > 0) ? incoming.LimitDown : prev?.LimitDown,
      TickTime:  incoming.TickTime  ?? prev?.TickTime  ?? '',
      TickType:  incoming.TickType  ?? prev?.TickType,
      Action:    incoming.Action    ?? prev?.Action    ?? '',
    };
    latestQuoteRef.current = merged;
    quoteDirtyRef.current = true;
    pendingHistoryRef.current.push(merged);
  }, []);

  // WebSocket 連線管理 — 定義為 ref 函式避免 useEffect 依賴問題
  const connectWsRef = useRef<() => void>(() => {});
  connectWsRef.current = () => {
    if (isUnmounted.current) return;
    // 如果已經有活躍連線，不要重複建立
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

    const wsUrl = `ws://${window.location.hostname}:8000/ws/quotes`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (isUnmounted.current) { ws.close(); return; }
      setIsConnected(true);
      reconnectDelayRef.current = 1000;
      const sym = targetSymbolRef.current;
      ws.send(JSON.stringify({ action: 'subscribe', symbol: sym }));
      console.log(`[WS] 連線成功，訂閱 ${sym}`);
      lastMessageTimeRef.current = Date.now();
    };

    ws.onmessage = (event) => {
      try {
        lastMessageTimeRef.current = Date.now();
        if (isStale) setIsStale(false);

        const data = JSON.parse(event.data);
        const isMatch = (payload: any): boolean => {
          if (!payload?.Symbol) return true;
          const sym = String(payload.Symbol).trim().toUpperCase();
          const target = targetSymbolRef.current.trim().toUpperCase();
          return sym === target;
        };

        if (data.type === 'Tick' && data.data && isMatch(data.data)) {
          mergeQuote(data.data as Partial<QuoteData>);
        } else if (data.type === 'BidAsk' && data.data) {
          if (isMatch(data.data)) {
            latestBidAskRef.current = data.data as BidAskData;
            bidaskDirtyRef.current = true;
          }
        } else if (data.type === 'AccountUpdate' && data.data) {
          pendingAccountRef.current = data.data;
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
    }
  }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectAccount = useCallback(async (fullId: string) => {
    setActiveAccount(fullId);
    isSwitchingAccountRef.current = true;
    try {
      await apiClient.post('/set_active_account', { account_id: fullId });
      setTimeout(() => { isSwitchingAccountRef.current = false; }, 2000);
    } catch (err) { isSwitchingAccountRef.current = false; }
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

  return (
    <TradingContext.Provider value={{
      isConnected, isStale, targetSymbol: targetSymbolState, setTargetSymbol,
      quote, bidAsk, quoteHistory, accountSummary, accounts, activeAccount,
      subscribe, selectAccount,
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
