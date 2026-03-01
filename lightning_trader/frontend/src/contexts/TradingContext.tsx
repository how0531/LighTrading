import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import type { QuoteData, BidAskData } from '../types';

interface AccountPosition {
  symbol: string;
  qty: number;
  direction: 'Buy' | 'Sell';
  price: number;
}

interface AccountSummary {
  "當日交易": number;
  "委託": number;
  "刪單": number;
  "未成交": number;
  "成交": number;
  "未平倉": number;
  "參考損益": number;
  positions?: AccountPosition[];
}

interface TradingContextType {
  isConnected: boolean;
  targetSymbol: string;
  setTargetSymbol: (sym: string) => void;
  quote: QuoteData | null;
  bidAsk: BidAskData | null;
  quoteHistory: QuoteData[];
  accountSummary: AccountSummary | null;
  subscribe: (symbol: string) => void;
}

const TradingContext = createContext<TradingContextType | null>(null);

export const TradingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [targetSymbol, setTargetSymbol] = useState("2330");
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [bidAsk, setBidAsk] = useState<BidAskData | null>(null);
  const [quoteHistory, setQuoteHistory] = useState<QuoteData[]>([]);
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Buffer for high-frequency messages to prevent excessive re-renders
  const pendingQuotesRef = useRef<QuoteData[]>([]);
  const pendingBidAskRef = useRef<BidAskData | null>(null);
  const pendingAccountRef = useRef<AccountSummary | null>(null);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    console.log("Connecting to WebSocket...");
    const wsUrl = `ws://${window.location.hostname}:8000/ws/quotes`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to Shioaji Backend');
      setIsConnected(true);
      reconnectAttemptsRef.current = 0; // Reset attempts on successful connection

      // Auto subscribe to default
      ws.send(JSON.stringify({ action: 'subscribe', symbol: targetSymbol }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'Tick' && data.data) {
          pendingQuotesRef.current.push(data.data);
        } else if (data.type === 'BidAsk' && data.data) {
          pendingBidAskRef.current = data.data;
        } else if (data.type === 'AccountUpdate' && data.data) {
          pendingAccountRef.current = data.data;
        }
      } catch (err) {
        console.error("Failed to parse message:", err);
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from backend');
      setIsConnected(false);

      // Exponential backoff strategy: 1s, 2s, 4s, 8s, up to max 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
      reconnectAttemptsRef.current += 1;
      console.log(`Will attempt to reconnect in ${delay}ms...`);

      reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
    };

    wsRef.current = ws;
  }, []); // Remove targetSymbol to prevent reconnect loop

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWebSocket]);

  // Throttled UI updates loop
  useEffect(() => {
    const updateInterval = setInterval(() => {
      if (pendingQuotesRef.current.length > 0) {
        const quotes = pendingQuotesRef.current;
        const latestQuote = quotes[quotes.length - 1];
        setQuote(latestQuote);
        setQuoteHistory(prev => {
          // Add new quotes in chronological order (latest is at the start or end?
          // Previous logic: newQuote, ...prev. We want latest first in the history array.
          // reversed order for the batched items so they maintain sequence
          const reversedQuotes = [...quotes].reverse();
          const newHist = [...reversedQuotes, ...prev];
          return newHist.slice(0, 50); // Keep last 50
        });
        pendingQuotesRef.current = [];
      }

      if (pendingBidAskRef.current) {
        setBidAsk(pendingBidAskRef.current);
        pendingBidAskRef.current = null;
      }

      if (pendingAccountRef.current) {
        setAccountSummary(pendingAccountRef.current);
        pendingAccountRef.current = null;
      }
    }, 150); // Throttle interval roughly 150ms

    return () => clearInterval(updateInterval);
  }, []);

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
      isConnected,
      targetSymbol,
      setTargetSymbol,
      quote,
      bidAsk,
      quoteHistory,
      accountSummary,
      subscribe
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
