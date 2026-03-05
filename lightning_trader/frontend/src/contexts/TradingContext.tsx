import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import type { QuoteData, BidAskData } from '../types';
import { apiClient } from '../api/client';

interface AccountPosition {
  symbol: string; qty: number; direction: 'Buy' | 'Sell'; price: number; pnl: number; account?: string; raw_qty?: number;
}

// 即時損益持倉（含前端隨 tick 重算的 realtimePnl）
export interface RealtimePosition extends AccountPosition {
  realtimePnl: number;       // 前端即時計算的損益
  pnlPerUnit: number;        // 每口/每張盈虧點數
  currentPrice: number;      // 計算時使用的最新價
}

// 商品乘數：股票=1000, 大台=200, 小台=50
const getMultiplier = (symbol: string): number => {
  const sym = symbol.toUpperCase();
  if (sym.startsWith('MXF') || sym.includes('小台')) return 50;
  if (sym.startsWith('TXF') || sym.includes('大台')) return 200;
  return 1000;
};
interface AccountSummary {
  "當日交易": number; "參考損益": number; positions: AccountPosition[]; is_simulation?: boolean; active_stock?: string; active_future?: string; person_id?: string; msg_count?: number;
}
interface AccountInfo {
  account_id: string; category: string; person_id: string; broker_id: string; account_name: string;
}
export interface WorkingOrder {
  symbol: string; action: 'Buy' | 'Sell'; price: number; qty: number; filled_qty: number; status: string; order_id?: string;
}
interface TradingContextType {
  isConnected: boolean; isStale: boolean; targetSymbol: string; setTargetSymbol: (sym: string) => void;
  quote: QuoteData | null; bidAsk: BidAskData | null; quoteHistory: QuoteData[];
  accountSummary: AccountSummary; accounts: AccountInfo[]; activeAccount: string | null;
  workingOrders: WorkingOrder[]; setWorkingOrders: React.Dispatch<React.SetStateAction<WorkingOrder[]>>; refreshOrders: () => Promise<void>;
  subscribe: (symbol: string) => void; selectAccount: (accountId: string) => Promise<void>;
  cancelOrder: (action: 'Buy' | 'Sell', price?: number) => Promise<void>;
  flattenPosition: (symbol: string) => Promise<void>;
  // 即時損益（前端隨 tick 計算）
  realtimePositions: RealtimePosition[];
  totalRealtimePnl: number;
  totalRealizedPnl: number;  // ★ 已實現損益（從後端 PnLUpdate 接收）
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
  const accountSummaryRef = useRef<AccountSummary>(initialSummary); // 用於即時損益計算，避免 setAccountSummary updater 反模式
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccount, setActiveAccount] = useState<string | null>(null);

  // 委託單狀態（部分由 WebSocket OrderUpdate 即時更新，部分由 REST 初始化）
  const [workingOrders, setWorkingOrders] = useState<WorkingOrder[]>([]);

  // 即時損益狀態（後端 WS PnLUpdate 推播）
  const [realtimePositions, setRealtimePositions] = useState<RealtimePosition[]>([]);
  const [totalRealtimePnl, setTotalRealtimePnl] = useState(0);
  const [totalRealizedPnl, setTotalRealizedPnl] = useState(0);

  // 抚取現在活躍委託單（就算無 WebSocket 也能同步）
  const refreshOrders = useCallback(async () => {
    try {
      const res = await apiClient.get('/order_history');
      const active: WorkingOrder[] = (res.data || []).filter((o: any) =>
        o.status === 'PendingSubmit' || o.status === 'PreSubmitted' ||
        o.status === 'Submitted' || o.status === 'PartFilled'
      );
      setWorkingOrders(active);
    } catch { /* 靜默，維持舊狀態 */ }
  }, []);

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
        const latestQ = { ...latestQuoteRef.current };
        setQuote(latestQ);

        // ★ 即時損益計算：每次 quote 更新時重算所有持倉的即時 PnL
        const latestPrice = latestQ.Price;
        if (latestPrice > 0) {
          const positions = accountSummaryRef.current.positions || [];
          if (positions.length === 0) {
            setRealtimePositions([]);
            setTotalRealtimePnl(0);
          } else {
            const targetSym = targetSymbolRef.current.toUpperCase();
            const targetCode = targetSym.replace(/\D/g, '');
            let totalPnl = 0;
            const rtPositions: RealtimePosition[] = positions.map(pos => {
              const posSym = (pos.symbol || '').toUpperCase();
              // 只有與當前訂閱商品匹配的持倉才用即時價格計算
              const isMatch = posSym === targetSym || (targetCode && posSym.includes(targetCode));
              if (isMatch && pos.price > 0) {
                const multiplier = getMultiplier(pos.symbol);
                const direction = pos.direction === 'Buy' ? 1 : -1;
                const pnlPerUnit = (latestPrice - pos.price) * direction;
                const realtimePnl = Math.round(pnlPerUnit * pos.qty * multiplier);
                totalPnl += realtimePnl;
                return { ...pos, realtimePnl, pnlPerUnit, currentPrice: latestPrice };
              } else {
                // 非當前商品：使用後端提供的 pnl
                totalPnl += (pos.pnl || 0);
                return { ...pos, realtimePnl: pos.pnl || 0, pnlPerUnit: 0, currentPrice: 0 };
              }
            });
            setRealtimePositions(rtPositions);
            setTotalRealtimePnl(totalPnl);
          }
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
        } else if (data.type === 'PnLUpdate' && data.data) {
          // ★ 後端即時 PnL 推播：直接更新 state（後端已計算好所有持倉）
          const { positions: rtPos, total_pnl, total_realized } = data.data;
          setRealtimePositions((rtPos as RealtimePosition[]) || []);
          setTotalRealtimePnl(total_pnl ?? 0);
          if (total_realized !== undefined) setTotalRealizedPnl(total_realized);
        } else if (data.type === 'OrderUpdate' && data.data) {
          // 即時更新委託單狀態（由 Shioaji callback 推送）
          // 外部平台下單/改單/刪單會觸發此事件。為確保資料一致性，不自己拼湊狀態，
          // 而是延遲 0.5s 等 Shioaji 內部狀態同步後，直接拉取 REST 最新快照。
          setTimeout(refreshOrders, 500);
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
      await apiClient.post('/cancel_all', {
        symbol: targetSymbolRef.current,
        action,
        ...(price !== undefined && { price })
      });
      setTimeout(refreshOrders, 500);
    } catch (err) {
      console.error('Cancel order failed:', err);
    }
  }, [refreshOrders]);

  const flattenPosition = useCallback(async (symbol: string) => {
    try {
      await apiClient.post('/flatten', { symbol });
      setTimeout(refreshOrders, 500);
    } catch (err) {
      console.error('Flatten position failed:', err);
    }
  }, [refreshOrders]);

  return (
    <TradingContext.Provider value={{
      isConnected, isStale, targetSymbol: targetSymbolState, setTargetSymbol,
      quote, bidAsk, quoteHistory, accountSummary, accounts, activeAccount,
      workingOrders, setWorkingOrders, refreshOrders,
      subscribe, selectAccount,
      cancelOrder, flattenPosition,
      realtimePositions, totalRealtimePnl, totalRealizedPnl,
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
