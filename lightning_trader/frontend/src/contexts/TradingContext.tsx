import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
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
  isConnected: boolean; targetSymbol: string; setTargetSymbol: (sym: string) => void;
  quote: QuoteData | null; bidAsk: BidAskData | null; quoteHistory: QuoteData[];
  accountSummary: AccountSummary; accounts: AccountInfo[]; activeAccount: string | null;
  subscribe: (symbol: string) => void; selectAccount: (accountId: string) => Promise<void>;
}

const TradingContext = createContext<TradingContextType | null>(null);

const initialSummary: AccountSummary = {
    "當日交易": 0, "參考損益": 0, positions: [], is_simulation: true, msg_count: 0
};

export const TradingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [targetSymbol, setTargetSymbol] = useState("2330");
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [bidAsk, setBidAsk] = useState<BidAskData | null>(null);
  const [quoteHistory, setQuoteHistory] = useState<QuoteData[]>([]);
  const [accountSummary, setAccountSummary] = useState<AccountSummary>(initialSummary);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccount, setActiveAccount] = useState<string | null>(null);
  
  const isSwitchingAccountRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingQuotesRef = useRef<QuoteData[]>([]);
  const pendingBidAskRef = useRef<BidAskData | null>(null);
  const pendingAccountRef = useRef<AccountSummary | null>(null);

  function connectWebSocket() {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const wsUrl = `ws://${window.location.hostname}:8000/ws/quotes`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      setIsConnected(true);
      ws.send(JSON.stringify({ action: 'subscribe', symbol: targetSymbol }));
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'Tick' && data.data) pendingQuotesRef.current.push(data.data);
        else if (data.type === 'BidAsk' && data.data) pendingBidAskRef.current = data.data;
        else if (data.type === 'AccountUpdate' && data.data) pendingAccountRef.current = data.data;
        else if (data.action === 'subscribe' && data.status === 'success') { if (data.symbol) setTargetSymbol(data.symbol); }
      } catch (err) { console.error(err); }
    };
    ws.onclose = () => { setIsConnected(false); setTimeout(connectWebSocket, 5000); };
    wsRef.current = ws;
  }

  useEffect(() => {
    connectWebSocket();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, []);

  useEffect(() => {
    const updateInterval = setInterval(() => {
      if (pendingQuotesRef.current.length > 0) {
        const quotes = pendingQuotesRef.current;
        setQuote(quotes[quotes.length - 1]);
        setQuoteHistory(prev => [...[...quotes].reverse(), ...prev].slice(0, 50));
        pendingQuotesRef.current = [];
      }
      if (pendingBidAskRef.current) {
        setBidAsk(pendingBidAskRef.current);
        pendingBidAskRef.current = null;
      }
      if (pendingAccountRef.current) {
        const summary = pendingAccountRef.current;
        setAccountSummary(summary);
        if (!isSwitchingAccountRef.current && summary.active_stock) setActiveAccount(summary.active_stock);
        pendingAccountRef.current = null;
      }
    }, 150);
    return () => clearInterval(updateInterval);
  }, []);

  useEffect(() => {
      if (isConnected) {
          apiClient.get('/accounts').then(res => {
              setAccounts(res.data);
              if (res.data.length > 0 && !activeAccount) setActiveAccount(`${res.data[0].broker_id}-${res.data[0].account_id}`);
          }).catch(e => console.error(e));
      }
  }, [isConnected]);

  const selectAccount = async (fullId: string) => {
      setActiveAccount(fullId);
      isSwitchingAccountRef.current = true;
      try {
          await apiClient.post('/set_active_account', { account_id: fullId });
          setTimeout(() => { isSwitchingAccountRef.current = false; }, 2000);
      } catch (err) { isSwitchingAccountRef.current = false; }
  };

  const subscribe = (symbol: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setTargetSymbol(symbol);
      setQuoteHistory([]);
      pendingQuotesRef.current = [];
      wsRef.current.send(JSON.stringify({ action: 'subscribe', symbol }));
    }
  };

  return (
    <TradingContext.Provider value={{
      isConnected, targetSymbol, setTargetSymbol, quote, bidAsk, quoteHistory, accountSummary, accounts, activeAccount, subscribe, selectAccount
    }}>
      {children}
    </TradingContext.Provider>
  );
};

export const useTradingContext = () => {
  const context = useContext(TradingContext);
  if (!context) throw new Error("useTradingContext must be used within a TradingProvider");
  return context;
};
