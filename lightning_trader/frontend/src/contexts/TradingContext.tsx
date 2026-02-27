import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
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

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const connectWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    console.log("Connecting to WebSocket...");
    const wsUrl = `ws://${window.location.hostname}:8000/ws/quotes`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to Shioaji Backend');
      setIsConnected(true);
      // Auto subscribe to default
      ws.send(JSON.stringify({ action: 'subscribe', symbol: targetSymbol }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'Tick' && data.data) {
          const newQuote = data.data;
          setQuote(newQuote);
          setQuoteHistory(prev => {
            const newHist = [newQuote, ...prev];
            if (newHist.length > 50) newHist.pop();
            return newHist;
          });
        } else if (data.type === 'BidAsk' && data.data) {
          setBidAsk(data.data);
        } else if (data.type === 'AccountUpdate' && data.data) {
          setAccountSummary(data.data);
        }
      } catch (err) {
        console.error("Failed to parse message:", err);
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from backend');
      setIsConnected(false);
      setTimeout(connectWebSocket, 5000);
    };

    wsRef.current = ws;
  };

  const subscribe = (symbol: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setTargetSymbol(symbol);
      setQuoteHistory([]);
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
