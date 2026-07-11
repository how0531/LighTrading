/**
 * src/contracts — 閃電下單 UI 的「對外穩定契約」單一權威型別來源
 * ============================================================================
 * @stable-contract
 *
 * 這裡集中定義**掛載式整併**（把本 UI 掛到任何底座／未來的 Shioaji Pro fork）
 * 所依賴的三個介面面：
 *   1. WS 線協定（後端 /ws/quotes 推播的每一個訊息 type ＋ 訂閱 ack）
 *   2. 兩個 React context value 形狀（useQuotes() / useTradingCore()）——
 *      定義site 仍在 contexts/TradingContext.tsx，此處 re-export 成單一契約表面
 *   3. context value 的「凍結鍵集合」常數（契約護欄測試的比對基準）
 *
 * ⚠️ 任何欄位/鍵的增刪改都是**破壞性契約變更**：必須同步更新
 *    docs/CONTRACT.md，並確認 TradingContext.contract.test.tsx 護欄測試。
 *    後端對應源頭：backend/bridge.py、backend/main.py、
 *    backend/services/{pnl_broadcaster,order_sync}.py。
 * ============================================================================
 */
import type { QuoteData, BidAskData } from '../types';
// 契約引用的 domain 型別定義site 仍在 TradingContext（既有 consumer 相容）；
// 此處為 type-only import（編譯期抹除，無 runtime 循環）。
import type {
  AccountSummary,
  RealtimePosition,
  WorkingOrder,
  SmartOrderData,
  BrokerState,
  QuotesContextType,
  TradingCoreContextType,
} from '../contexts/TradingContext';

// 契約表面：從 contracts 一處即可取得 context/domain 型別 -----------------
export type {
  QuotesContextType,
  TradingCoreContextType,
  TradingContextType,
  AccountPosition,
  RealtimePosition,
  AccountSummary,
  AccountInfo,
  WorkingOrder,
  SmartOrderData,
  BrokerState,
  FillEvent,
  RiskAlert,
  MiniQuote,
} from '../contexts/TradingContext';
export type { QuoteData, BidAskData } from '../types';

// ── 雙序號語意（seq_no / seq_kind） ───────────────────────────────────────
/**
 * 後端分流的兩條獨立單調序號流（見 backend/shared.py）：
 *  - 'callback' ：Shioaji order_callback 推送的 OrderUpdate（本 session 下的單）
 *  - 'snapshot' ：REST 快照 / 對帳迴圈推播的 WorkingOrdersSnapshot（含外部管道下的單）
 * 前端各自比較自己的 ref，避免兩流交錯導致丟更新。
 */
export type SeqKind = 'callback' | 'snapshot';

// ── 後端 → 前端：WS 推播訊息（以 `type` 為判別式） ─────────────────────────
/** 高頻逐筆成交（backend/bridge.py on_shioaji_quote → tick_data） */
export interface TickMessage {
  type: 'Tick';
  data: QuoteData;
}
/** 五檔委買委賣（同上，bidask_data） */
export interface BidAskMessage {
  type: 'BidAsk';
  data: BidAskData;
}
/** 帳務摘要（on_shioaji_account_update） */
export interface AccountUpdateMessage {
  type: 'AccountUpdate';
  data: AccountSummary;
}
/** 即時損益（pnl_broadcaster；後端已算好每一持倉） */
export interface PnLUpdateMessage {
  type: 'PnLUpdate';
  data: {
    positions: RealtimePosition[];
    total_pnl: number;
    total_realized?: number;
  };
}
/** 訂單狀態回報（callback 流，帶 callback 序號） */
export interface OrderUpdateMessage {
  type: 'OrderUpdate';
  seq_no: number;
  seq_kind?: 'callback';
  data: Record<string, unknown>;
}
/** 委託對帳快照（snapshot 流，外部管道下單即時出現） */
export interface WorkingOrdersSnapshotMessage {
  type: 'WorkingOrdersSnapshot';
  seq_no: number;
  seq_kind?: 'snapshot';
  data: { orders: WorkingOrder[] };
}
/** 智慧單狀態（新增 / 觸發 / CHASE 追價進度 / 取消） */
export interface SmartOrderUpdateMessage {
  type: 'SmartOrderUpdate';
  data: SmartOrderData;
}
/** 成交回報（Shioaji deal callback 或 order_sync SyncDeal；欄位鍵名不一致，全 optional） */
export interface TradeUpdateMessage {
  type: 'TradeUpdate';
  data: {
    id?: string | number;
    symbol?: string;
    code?: string;
    action?: string;
    price?: number;
    quantity?: number;
    qty?: number;
    order_id?: string;
    ordno?: string;
    state?: string;
    status?: string;
    source?: string;
    [k: string]: unknown;
  };
}
/** 券商連線狀態（WS accept 後的 hello frame 亦走此型別） */
export interface ConnectionStateMessage {
  type: 'ConnectionState';
  data: { broker: BrokerState | string };
}
/** 風控熔斷 / 警示即時告警 */
export interface RiskStatusUpdateMessage {
  type: 'RiskStatusUpdate';
  data: { level: 'block' | 'warning' | string; reason?: string };
}
/** 心跳（每 3s；stale watchdog 的訊息流依據，無 data） */
export interface HeartbeatMessage {
  type: 'Heartbeat';
}

/** 後端 → 前端：所有 `type`-判別式推播訊息的聯集 */
export type WsServerMessage =
  | TickMessage
  | BidAskMessage
  | AccountUpdateMessage
  | PnLUpdateMessage
  | OrderUpdateMessage
  | WorkingOrdersSnapshotMessage
  | SmartOrderUpdateMessage
  | TradeUpdateMessage
  | ConnectionStateMessage
  | RiskStatusUpdateMessage
  | HeartbeatMessage;

/** WS 推播訊息的 `type` 欄位字面值聯集 */
export type WsServerMessageType = WsServerMessage['type'];

// ── 訂閱 / 自選 的請求—回應（以 `action` 為判別式，非 `type`） ──────────────
/** 後端 → 前端：subscribe 的 ack（成功帶 symbol；失敗帶 message） */
export interface SubscribeResponse {
  action: 'subscribe';
  status: 'success' | 'error';
  symbol?: string;
  message?: string;
}
/** 後端 → 前端：watch（自選背景訂閱）的 ack */
export interface WatchResponse {
  action: 'watch';
  status: 'success' | 'error';
  /** 已接受的自選 symbol（使用者輸入形式，大寫） */
  symbols?: string[];
  /** 被拒絕的 symbol（無效 / 超過 30 上限） */
  rejected?: string[];
  /** 使用者輸入 → canonical 廣播 key 的別名表（例：2330 → TSE2330） */
  aliases?: Record<string, string>;
  message?: string;
}
/** 後端 → 前端：所有 `action`-判別式回應的聯集 */
export type WsServerResponse = SubscribeResponse | WatchResponse;

/** 前端 → 後端：訂閱主商品 */
export interface SubscribeRequest {
  action: 'subscribe';
  symbol: string;
}
/** 前端 → 後端：自選 / 多圖背景訂閱（聯集後送出） */
export interface WatchRequest {
  action: 'watch';
  symbols: string[];
}
/** 前端 → 後端：出站訊息聯集 */
export type WsClientMessage = SubscribeRequest | WatchRequest;

/** WS 連線上可能收到的任一 inbound 訊息（推播 ＋ ack） */
export type WsInboundMessage = WsServerMessage | WsServerResponse;

// ── 凍結鍵集合：契約護欄測試的比對基準 ─────────────────────────────────────
/**
 * useQuotes() 回傳物件的凍結鍵集合。
 * 順序無關（護欄測試以集合比對）；新增/移除鍵 = 破壞性契約變更。
 */
export const QUOTES_CONTEXT_KEYS = [
  'quote',
  'bidAsk',
  'quoteHistory',
  'watchlistQuotes',
  'bidAskBySymbol',
  'realtimePositions',
  'totalRealtimePnl',
  'totalRealizedPnl',
] as const;

/**
 * useTradingCore() 回傳物件的凍結鍵集合。
 * 順序無關；新增/移除鍵 = 破壞性契約變更。
 */
export const TRADING_CORE_CONTEXT_KEYS = [
  'isConnected',
  'isStale',
  'isTickStale',
  'brokerState',
  'recentFills',
  'riskAlert',
  'targetSymbol',
  'setTargetSymbol',
  'watchSymbols',
  'setAuxWatch',
  'accountSummary',
  'accounts',
  'activeAccount',
  'workingOrders',
  'setWorkingOrders',
  'refreshOrders',
  'scheduleOrderRefresh',
  'syncAll',
  'forceReconnect',
  'subscribe',
  'selectAccount',
  'cancelOrder',
  'flattenPosition',
  'smartOrders',
  'refreshSmartOrders',
] as const;

export type QuotesContextKey = (typeof QUOTES_CONTEXT_KEYS)[number];
export type TradingCoreContextKey = (typeof TRADING_CORE_CONTEXT_KEYS)[number];

// ── 編譯期一致性防呆 ───────────────────────────────────────────────────────
// 凍結鍵集合必須與 context 型別的 keyof 完全相等（雙向）。任一邊新增/移除鍵
// 而未同步另一邊 → 下方 `true` 不能賦值給 `never` → tsc 直接失敗。
// 這讓「改了 context 型別卻忘了更新契約」在編譯期就被擋下（護欄測試是第二道）。
type _AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _quotesKeysExhaustive: _AssertExact<QuotesContextKey, keyof QuotesContextType> = true;
const _coreKeysExhaustive: _AssertExact<TradingCoreContextKey, keyof TradingCoreContextType> = true;
void _quotesKeysExhaustive;
void _coreKeysExhaustive;
