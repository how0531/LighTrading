export interface QuoteData {
  Symbol: string;
  Price: number;
  Volume: number;
  Open?: number;
  High?: number;
  Low?: number;
  AvgPrice?: number;
  Reference?: number;
  LimitUp?: number;
  LimitDown?: number;
  TickTime: string;
  Action: string;
}

export interface BidAskData {
  Symbol: string;
  BidPrice: number[];
  BidVolume: number[];
  AskPrice: number[];
  AskVolume: number[];
  DiffBidVol?: number[];
  DiffAskVol?: number[];
  Time: string;
}

export interface AccountData {
  balance: number;
  equity: number;
  unrealizedPnL: number;
}

export interface PositionData {
  symbol: string;
  qty: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
}
