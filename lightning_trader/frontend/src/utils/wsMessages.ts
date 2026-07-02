/**
 * wsMessages.ts — /ws/quotes 推播訊息的型別（Phase 1 磚二：WS 型別化）
 *
 * 欄位逐一對照後端原始碼的實際 serialize（不是從前端使用處反推）：
 *   - bridge.py:on_shioaji_quote        → Tick / BidAsk
 *   - bridge.py:on_shioaji_account_update → AccountUpdate
 *   - bridge.py:on_shioaji_order_update  → OrderUpdate（頂層帶 seq_no / seq_kind）
 *   - bridge.py:on_shioaji_trade_update  → TradeUpdate
 *   - bridge.py:on_smart_order_update    → SmartOrderUpdate
 *   - pnl_broadcaster._compute_pnl_payload → PnLUpdate
 *   - main.py WS handler                 → subscribe / watch 的 ack
 *
 * 後端 payload 是動態 dict、欄位可能缺漏 → 一律用 optional / unknown，
 * 不斷言存在；語意型別（AccountSummary / SmartOrderData）由消費端
 * （TradingContext）自行 narrow，避免循環 import。
 */
import type { QuoteData, BidAskData } from '../types';

/**
 * 資料訊息共用 base：把 ack 專屬欄位宣告成 optional undefined，
 * 讓 onmessage 的 else-if 鏈（先比對 type、最後比對 action）能正確 narrow。
 */
interface WSDataBase {
  action?: undefined;
  status?: undefined;
}

/** Tick 的 data：bridge 只保證 Symbol/Price/Volume 等核心欄，其餘視情況附帶 */
export interface WSTickMessage extends WSDataBase {
  type: 'Tick';
  data: Partial<QuoteData>;
}

export interface WSBidAskMessage extends WSDataBase {
  type: 'BidAsk';
  data: BidAskData;
}

/** 帳務摘要：後端直接轉發 summary dict，形狀由 TradingContext 的 AccountSummary 消化 */
export interface WSAccountUpdateMessage extends WSDataBase {
  type: 'AccountUpdate';
  data: unknown;
}

/** 即時損益：pnl_broadcaster 保證三個 key，positions 內容由消費端 narrow */
export interface WSPnLUpdateMessage extends WSDataBase {
  type: 'PnLUpdate';
  data: {
    positions?: unknown[];
    total_pnl?: number;
    total_realized?: number;
  };
}

export interface WSOrderUpdateMessage extends WSDataBase {
  type: 'OrderUpdate';
  data: Record<string, unknown>;
  seq_no?: number;
  seq_kind?: string;
}

export interface WSTradeUpdateMessage extends WSDataBase {
  type: 'TradeUpdate';
  data: Record<string, unknown>;
}

/** 智慧單：SmartOrder.to_dict()，由消費端 narrow 成 SmartOrderData */
export interface WSSmartOrderUpdateMessage extends WSDataBase {
  type: 'SmartOrderUpdate';
  data: unknown;
}

/** subscribe / watch 的 ack（無 type 欄位，以 action 區分） */
export interface WSAckMessage {
  type?: undefined;
  action: 'subscribe' | 'watch';
  status: 'success' | 'error';
  symbol?: string;      // subscribe ack
  symbols?: string[];   // watch ack：成功清單
  rejected?: string[];  // watch ack：被拒清單
  message?: string;     // error ack 的說明
}

export type WSMessage =
  | WSTickMessage
  | WSBidAskMessage
  | WSAccountUpdateMessage
  | WSPnLUpdateMessage
  | WSOrderUpdateMessage
  | WSTradeUpdateMessage
  | WSSmartOrderUpdateMessage
  | WSAckMessage;
