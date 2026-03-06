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
  TickType?: number;
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

// 商品乘數：統一版本，涵蓋台灣與海外期貨
export const getMultiplier = (symbol: string): number => {
  const sym = symbol.toUpperCase();
  // 台灣期貨
  if (sym.startsWith('MXF') || sym.includes('小台')) return 50;
  if (sym.startsWith('TXF') || sym.includes('大台')) return 200;
  // 海期微型
  if (sym.startsWith('MYM')) return 0.5;   // 微道瓊 USD 0.5
  if (sym.startsWith('MNQ')) return 2;     // 微那斯達克 USD 2
  if (sym.startsWith('MES')) return 5;     // 微標普 USD 5
  // 海期小型
  if (sym.startsWith('UD')) return 5;      // 小道瓊 USD 5
  if (sym.startsWith('NQ')) return 20;     // 小那斯達克 USD 20
  if (sym.startsWith('ES')) return 50;     // 小標普 USD 50
  // 預設：台股=1000 元/張
  return 1000;
};
