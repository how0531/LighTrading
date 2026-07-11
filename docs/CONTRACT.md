# LighTrade 對外契約規格（CONTRACT.md）

> **狀態：凍結（Frozen）— 階段 1 契約凍結產出。**
> 本文件是閃電下單 UI 與其底座（後端交易大腦；未來可能是 Shioaji Pro fork）之間的
> **正式對外介面規格**。任何欄位／鍵／簽名的增刪改都是**破壞性契約變更**，必須：
> 1. 同步更新本文件；
> 2. 同步 `frontend/src/contracts/`（型別與凍結鍵集合）；
> 3. 通過 `frontend/src/contexts/TradingContext.contract.test.tsx` 護欄測試；
> 4. 若動到後端推播／端點，同步對應的 pytest。
>
> 契約表面在程式碼中以 `@stable-contract` 標註。本文件**只描述現況（以碼為準）**，不改變任何執行行為。

契約來源（single source of truth）：
- 前端型別：`frontend/src/contracts/index.ts`、`frontend/src/types.ts`、`frontend/src/contexts/TradingContext.tsx`
- WS 推播格式化：`backend/bridge.py`、`backend/main.py`（`/ws/quotes`）、`backend/services/pnl_broadcaster.py`、`backend/services/order_sync.py`
- REST 端點：`backend/routers/{orders,accounts,smart,risk,health,journal,reports,user_settings}.py`
- 序號分流：`backend/shared.py`
- 引擎注入契約：`core/smart_order_engine.py`（`set_dispatch` / `set_chase_helpers`）＋ `backend/main.py`（注入點）

---

## A. WebSocket 契約 — `/ws/quotes`

單一雙向通道。Token 認證啟用（`LIGHTRADE_API_TOKEN`）時，連線需帶 query `?token=<token>`；
認證失敗以自訂關閉碼 **4401** 關閉（前端據此停止自動重連）。

### A.1 連線握手與訊息封套

- **accept 後立即送 hello frame**：一筆 `ConnectionState`，讓晚加入的客戶端立即同步券商連線狀態（僅發給該連線）。
- 所有推播訊息為 JSON 物件。**兩種判別式**：
  - **`type`** 欄位 → 後端主動推播（見 A.2）。
  - **`action`** 欄位 → 對客戶端 `subscribe`/`watch` 請求的 ack（見 A.4）。
- 前端型別：`WsServerMessage`（type 聯集）、`WsServerResponse`（action 聯集）、`WsInboundMessage`（兩者聯集），定義於 `frontend/src/contracts/index.ts`。

### A.2 後端 → 前端 推播訊息（每一個 `type`，以碼為準）

| `type` | 來源 | `data` 欄位 | 序號 |
|---|---|---|---|
| `Tick` | bridge `on_shioaji_quote` | `Symbol, Price, Volume, Open, High, Low, AvgPrice, TickType, TickTime, Action`；選配 `Reference, LimitUp, LimitDown, TotalVolume`（>0 才帶） | 無 |
| `BidAsk` | bridge `on_shioaji_quote` | `Symbol, AskPrice[], AskVolume[], BidPrice[], BidVolume[], DiffBidVol[], DiffAskVol[], Time` | 無 |
| `AccountUpdate` | bridge `on_shioaji_account_update` | `AccountSummary`（見 D.3）：`當日交易, 參考損益, positions[], is_simulation?, active_stock?, active_future?, person_id?, msg_count?` | 無 |
| `PnLUpdate` | `pnl_broadcaster` | `positions: RealtimePosition[]`（原持倉欄位 ＋ `realtimePnl, pnlPerUnit, currentPrice`）、`total_pnl`、`total_realized` | 無 |
| `OrderUpdate` | bridge `on_shioaji_order_update` | Shioaji order callback 原始 dict（`state/operation/ordno/seqno/order{}` 等） | **`seq_no`（callback 流）、`seq_kind:"callback"`** |
| `TradeUpdate` | bridge `on_shioaji_trade_update` / `order_sync` | 成交 dict；鍵名依來源不一致（`symbol`\|`code`、`quantity`\|`qty`、`order_id`\|`ordno`、`id`、`action`、`price`、`state`、`source`） | 無 |
| `SmartOrderUpdate` | bridge `on_smart_order_update` | `SmartOrderData`（見 D.4；含 CHASE 延伸欄位 `current_price, reprice_count, remaining_qty, max_chase_ticks, final_action, status`） | 無 |
| `WorkingOrdersSnapshot` | `order_sync.sync_once` | `{ orders: WorkingOrder[] }` | **`seq_no`（snapshot 流）、`seq_kind:"snapshot"`** |
| `ConnectionState` | bridge `on_connection_state` / hello frame | `{ broker: "connected"｜"disconnected"｜"reconnecting" }` | 無 |
| `RiskStatusUpdate` | bridge `on_risk_breach_ws` | `{ level: "block"｜"warning", reason: string }` | 無 |
| `Heartbeat` | `pnl_broadcaster.heartbeat_loop` | *(無 `data`)* — 每 3s；前端 stale watchdog 依據 | 無 |

### A.3 雙序號（`seq_no` / `seq_kind`）語意

後端分流為兩條獨立單調序號流（`backend/shared.py`，基準值 = 啟動時 epoch ms）：

- **`callback` 流** — `generate_callback_seq()`：`OrderUpdate`（Shioaji order_callback，僅本 session 下的單）。
- **`snapshot` 流** — `generate_snapshot_seq()`（`generate_order_seq()` 為其別名）：REST 快照（`/place_order`、`/cancel_all`、`/order_history`、`/sync_all`）與對帳迴圈的 `WorkingOrdersSnapshot`（含外部管道下的單）。

**不變式**：前端各流各自保留一個 `ref`，只有 `incoming_seq >= ref` 才套用並前移 ref（見 `TradingContext` 的 `callbackSeqRef` / `snapshotSeqRef`）。兩流互不干擾，避免交錯造成丟更新或亂序回填。`OrderUpdate` 只帶 `seq_kind:"callback"`；`WorkingOrdersSnapshot` 只帶 `seq_kind:"snapshot"`。

### A.4 訂閱 / 自選 的 ack（以 `action` 判別）

**前端 → 後端（出站）**
- `{ action: "subscribe", symbol }` — 訂閱主商品。
- `{ action: "watch", symbols: string[] }` — 自選 ＋ 多圖背景訂閱的**聯集**（上限 30）。

**後端 → 前端（ack）**
- `{ action:"subscribe", status:"success", symbol }` — 成功（`symbol` 為券商回傳的實際 symbol）。
- `{ action:"subscribe", status:"error", symbol?, message }` — 未登入等；前端無上限退避重試（2.5s 起 ×1.5 封頂 10s）。
- `{ action:"watch", status:"success", symbols:[], rejected:[], aliases:{} }` — `aliases` 是「使用者輸入 → canonical 廣播 key」對照（例 `2330 → TSE2330`），tick/bidask 進來時據此歸一回自選 key。
- `{ action:"watch", status:"error", message }` — 未登入；前端 3s 後重試（最多 5 次）。

---

## B. REST 契約 — `/api/*`

Base URL 由 `resolveApiBaseUrl()` 決定。Token 啟用時所有 `/api/*`（除 `/api/health`）需帶 header `X-API-Token`（`/ws/quotes` 走 query token）。

### B.1 統一錯誤 envelope

所有錯誤回應 body 皆為 `{ "detail": <envelope> }`，`envelope` 至少含 `{ code, user_msg }`，選配 `level`、`warnings`。
前端 `normalizeApiError`（`api/client.ts`）解析為 `LighTradeApiError { status, code, user_msg, level?, warnings?, raw? }`。
- 部分端點 `raise HTTPException(detail="純字串")` → 前端以 `code:"API_ERROR"`、`user_msg=該字串` 呈現。
- 未捕捉例外 → 全域 handler 回 500 `{ code:"INTERNAL_ERROR", user_msg:"伺服器發生未預期錯誤…" }`。
- Token 錯誤 → 401 `{ code:"UNAUTHORIZED", user_msg:"缺少或錯誤的 API Token…" }`。

**兩個關鍵風控 envelope（下單路徑）**
- **409 `CONFIRM_REQUIRED`**：`{ code:"CONFIRM_REQUIRED", user_msg, warnings: string[], level:"warning" }` — RiskManager WARNING（市價單／價格偏離／反向等）。前端彈確認框，帶 `confirm:true` 重送即通過。
- **422 `RISK_BLOCK`**：`{ code:"RISK_BLOCK", user_msg, level:"block" }` — 硬阻擋（日虧損熔斷、部位上限等），不可 confirm 繞過。（注意：`/update_order`、`/reverse` 的 `RISK_BLOCK` 不帶 `level`。）

### B.2 訂單端點（`backend/routers/orders.py`）

| Method Path | Request | 成功回應 | 錯誤 |
|---|---|---|---|
| `POST /api/place_order` | `{ symbol, price(0=市價), action, qty, order_type="ROD", price_type="LMT", order_cond="Cash", order_lot="Common", confirm=false }` | `{ status:"success", message, data:{ seq_no(snapshot), orders: WorkingOrder[] } }` | 409 `CONFIRM_REQUIRED`；422 `RISK_BLOCK`；400 `ORDER_FAILED`；rate limit |
| `POST /api/update_order` | `{ symbol, action, old_price, new_price, qty? }` | `{ status:"success", message }` | 422 `RISK_BLOCK`（風控停止交易時封鎖改單，無 `level`）；400 `ORDER_NOT_FOUND` |
| `POST /api/cancel_all` | `{ symbol, action, price?(None=撤整側；有值=只撤該精確價位) }` | `{ status:"success", message, cancelled: number, data:{ seq_no(snapshot), orders } }` | 500 `CANCEL_FAILED` |
| `POST /api/flatten` | `{ symbol, cancel_pending=true }` | `{ status:"success", message, cancelled_pending: bool }` | 400 `FLATTEN_FAILED` |
| `POST /api/reverse` | `{ symbol }` | `{ status:"success", message }` | 503 `POSITIONS_UNAVAILABLE`；422 `RISK_BLOCK`（無 `level`）；400 `REVERSE_FAILED` |

**`/cancel_all` price 分支**（契約關鍵）：`price=None` → `cancel_all`（整側，含手動單）；`price` 有值 → `cancel_orders_by_action_price`（只撤該精確價位）。`cancelled` 為實際送出撤單數；該價位已無委託時據實回 `cancelled:0`。回應恆帶最新活躍委託快照（snapshot 序號）。

### B.3 帳務端點（`backend/routers/accounts.py`）

| Method Path | Request | 成功回應 |
|---|---|---|
| `POST /api/login` | `{ api_key?, secret_key?, simulation=true, ca_path?, ca_passwd? }`（空金鑰改用 .env） | `{ status:"success", message, already? }`；錯誤 400 `MISSING_CREDENTIALS`/`LOGIN_EXCEPTION`/`LOGIN_FAILED` |
| `POST /api/set_active_account` | `{ account_id }` | `{ status:"success", message }`；400 `ACCOUNT_SWITCH_FAILED` |
| `GET /api/positions?account_id=` | — | `Position[]`（失敗回 `[]`） |
| `GET /api/account_balance` | — | `{ equity, margin_available, margin_required, pnl }` 或 `{}` |
| `GET /api/order_history?account_id=` | — | `{ seq_no(snapshot), orders: [{ time, symbol, action, price, qty, status, failed_msg, filled_qty, filled_avg_price }] }` |
| `GET /api/accounts` | — | `AccountInfo[]`（見 D.3） |
| `GET /api/kbars?symbol=&days=1` | — | K 棒陣列（未登入/無料回 `[]`；days clamp 1–30） |
| `POST /api/unwatch` | `{ symbols: string[] }` | `{ status:"success", removed:[], skipped:[] }`（持倉/主商品保護） |
| `GET /api/symbols/search?q=&limit=20` | — | `[{ symbol, code, name, kind }]`（含離線 fallback） |
| `POST /api/sync_all` | — | `{ status:"success", seq_no(snapshot), working_orders: WorkingOrder[], positions }`；未登入 409 `NOT_LOGGED_IN`；500 `SYNC_FAILED` |

### B.4 智慧單端點（`backend/routers/smart.py`）

| Method Path | Request | 成功回應 |
|---|---|---|
| `POST /api/smart_orders` | `SmartOrderRequest`（見下） | 依型別：`{ status:"success", message, id }`；CHASE 另帶 `chase_price`；OCO/Bracket 帶 `id` |
| `GET /api/smart_orders?symbol=` | — | 活躍智慧單陣列（`SmartOrderData[]`） |
| `DELETE /api/smart_orders/{order_id}` | — | `{ status:"success", message, id }`；404 `SMART_ORDER_NOT_FOUND` |
| `POST /api/smart_orders/cancel_all?symbol=` | — | `{ status:"success", cancelled: number }` |

`SmartOrderRequest` 支援型別：`STOP`/`MIT`（`trigger_price` ＋ `trigger_condition`，`stop_price` 為 alias）、`TRAILING`（`trailing_offset>0`）、`OCO`（`take_profit_price` ＋ `stop_loss_price`）、`BRACKET`（`entry_price` ＋ TP ＋ SL）、`CHASE`（`max_chase_ticks=10`、`reprice_ticks=1`、`reprice_interval_ms=1500`（下限 500）、`final_action∈{GIVE_UP,MARKET}`；`quantity` 為 `qty` 的 alias）。
智慧單專屬錯誤碼：422 `INVALID_QTY`/`INVALID_OCO`/`INVALID_BRACKET`/`INVALID_TRAILING`/`INVALID_TRIGGER`/`INVALID_CHASE`/`NO_QUOTE`/`RISK_BLOCK`；502 `CHASE_ENTRY_FAILED`；503 `ENGINE_UNAVAILABLE`。

### B.5 其他 router（端點清單，錯誤 envelope 同 B.1）

- `risk.py`：`GET /api/risk_status`、`GET /api/risk_config`、`PUT /api/risk_config`、`POST /api/risk_reset_daily`。
- `health.py`：`GET /api/health`（免 token）、`GET /api/metrics`。
- `journal.py`（prefix `/api/journal`）：`GET /fills`、`GET /stats`、`GET /equity`、`GET /stats_advanced`、`POST /fill/{fill_id}/meta`、`POST /import`。
- `reports.py`：`GET /api/daily_report`。
- `user_settings.py`：`GET /api/user_settings`、`PUT /api/user_settings`。

---

## C. SmartOrderEngine 注入契約（broker 解耦）

引擎（`core/smart_order_engine.py`）對 broker **完全解耦**，靠 4 個注入函數 ＋ 一個派工 hook。
注入點在 `backend/main.py`（開機一次）。語意不變式如下 —— **這是底座替換時唯一必須滿足的行為約定**。

| 注入槽 | 注入來源（backend） | 簽名 | 語意不變式 |
|---|---|---|---|
| `_place_order`（`place`） | `order_guard.smart_place_order` | `(symbol: str, price: float, action: "Buy"｜"Sell", qty: int) -> trade｜"RISK_BLOCKED"｜None` | **走統一風控路徑**：內含淨部位判定＋ RiskManager 前置檢查。回 shioaji trade=成功；回哨兵字串 `"RISK_BLOCKED"`=被風控攔（引擎不 re-arm）；回 `None`=下單失敗（引擎會 re-arm 重試）。`price=0` 表市價。 |
| `set_dispatch(dispatch)`（派工 hook） | `shared.submit_order_task`（專用 order executor，`max_workers=1`） | `dispatch: (fn: Callable) -> None` | 觸發後的實際下單／改價／收尾**丟到專用低延遲通道**執行，不排在 kbars/搜尋等慢查詢後、也不在行情執行緒上同步下單。未注入時（測試）同步執行。 |
| `_cancel_order`（`cancel`） | `shioaji_client.cancel_order_by_ids` | `(order_ids: list[str]) -> bool` | 依單號（id/seqno/ordno 任一）撤「一張」活躍委託。`True`=已送出撤單；`False`=找不到活躍對應單（可能已全成/已被撤，交給成交/對帳路徑收尾）。 |
| `_confirm_cancel`（`confirm_cancel`） | `shioaji_client.confirm_order_cancelled` | `(order_ids: list[str]) -> { "cancelled": bool, "filled_qty": int } ｜ None` | **CHASE cancel-replace 的安全閘**：確認一張委託已離開活躍集合並回報**實際累計成交量**。`{cancelled:True, filled_qty:n}`=已離開活躍集合（撤成/已成/消失）→ 可安全以實際剩量掛新腿；`{cancelled:False,...}`=逾時仍活躍（本輪放棄，保留舊單）；`None`=查詢失敗（本輪放棄）。**未注入 → 退回舊行為（信任 remaining_qty）**。不變式：撤單未確認前不得送新腿（避免撤單在途部分成交造成超額建倉）。 |
| `_tick_size`（`tick_size`） | `contract_specs.get_tick_size`（＝ `core.default_tick_size`） | `(price: float, symbol: str) -> float` | 回該價格／商品的最小跳動級距（選擇權權利金、各期貨、ETF、個股分段）。未注入時用 core 內建 `default_tick_size`（與 backend 版邏輯一致，讓 core 可獨立運作）。 |

`set_chase_helpers(cancel_order_fn?, tick_size_fn?, confirm_cancel_fn?)` 一次注入後三者（僅覆寫非 None 參數）。
CHASE 終態集合：`FILLED, GAVE_UP, COMPLETED, CANCELLED, CANCELLED_EXTERNAL, RISK_BLOCKED, FAILED`。

---

## D. 前端 Context 對外介面

Provider `TradingProvider` 拆成高頻 `QuotesContext` 與低頻 `TradingCoreContext` 兩個 context，
分別由 `useQuotes()` / `useTradingCore()` 取用（`useTradingContext()` 為合併相容 hook）。
型別 ＋ 凍結鍵集合集中於 `frontend/src/contracts/index.ts`；`QuotesContextType` / `TradingCoreContextType`
定義site 在 `TradingContext.tsx`（標 `@stable-contract`）。護欄測試比對**執行期真實 value 物件的鍵**。

### D.1 `useQuotes(): QuotesContextType` — 8 鍵（`QUOTES_CONTEXT_KEYS`）

| 鍵 | 型別 |
|---|---|
| `quote` | `QuoteData ｜ null` |
| `bidAsk` | `BidAskData ｜ null` |
| `quoteHistory` | `QuoteData[]`（逐筆 tape，含前端指派 `Seq`） |
| `watchlistQuotes` | `Record<string, MiniQuote>`（key=canonical 歸一後的自選 key） |
| `bidAskBySymbol` | `Record<string, BidAskData>`（自選商品完整五檔） |
| `realtimePositions` | `RealtimePosition[]` |
| `totalRealtimePnl` | `number` |
| `totalRealizedPnl` | `number` |

### D.2 `useTradingCore(): TradingCoreContextType` — 25 鍵（`TRADING_CORE_CONTEXT_KEYS`）

狀態鍵：`isConnected, isStale, isTickStale, brokerState, recentFills, riskAlert, targetSymbol, accountSummary, accounts, activeAccount, workingOrders, smartOrders`。
方法鍵：`setTargetSymbol, watchSymbols, setAuxWatch, setWorkingOrders, refreshOrders, scheduleOrderRefresh, syncAll, forceReconnect, subscribe, selectAccount, cancelOrder, flattenPosition, refreshSmartOrders`。

方法簽名（節選，以碼為準）：
- `setTargetSymbol(sym: string): void`
- `watchSymbols(syms: string[]): void` / `setAuxWatch(syms: string[]): void`（兩來源取聯集送後端）
- `refreshOrders(): Promise<void>` / `scheduleOrderRefresh(): void`（leading-edge debounce 500ms）/ `syncAll(): Promise<void>` / `forceReconnect(): void`
- `subscribe(symbol: string): void` / `selectAccount(accountId: string): Promise<void>`
- `cancelOrder(action: "Buy"｜"Sell", price?: number): Promise<void>` / `flattenPosition(symbol: string, cancelPending?: boolean): Promise<void>`
- `refreshSmartOrders(symbol?: string): Promise<void>`

### D.3 帳務型別

- `AccountSummary`：`{ "當日交易": number, "參考損益": number, positions: AccountPosition[], is_simulation?, active_stock?, active_future?, person_id?, msg_count? }`
- `AccountPosition`：`{ symbol, qty, direction: "Buy"｜"Sell", price, pnl, account?, raw_qty? }`
- `RealtimePosition extends AccountPosition`：＋ `{ realtimePnl, pnlPerUnit, currentPrice }`
- `AccountInfo`：`{ account_id, category, person_id, broker_id, account_name }`
- `WorkingOrder`：`{ symbol, action: "Buy"｜"Sell", price, qty, filled_qty, status, order_id? }`

### D.4 智慧單型別 `SmartOrderData`

`{ id, symbol, order_type, action, qty, trigger_price, trigger_condition, trailing_offset, take_profit_price, stop_loss_price, is_active, is_triggered, created_at, triggered_at? }`
＋ CHASE 延伸（全 optional，前端防禦性取值）：`current_price?, reprice_count?, remaining_qty?, max_chase_ticks?, final_action?, status?`。

### D.5 行情型別（`frontend/src/types.ts`）

- `QuoteData`：`{ Symbol, Price, Volume, TotalVolume?, Open?, High?, Low?, AvgPrice?, Reference?, LimitUp?, LimitDown?, TickTime, TickType?, Action, Seq? }`
- `BidAskData`：`{ Symbol, BidPrice[], BidVolume[], AskPrice[], AskVolume[], DiffBidVol?, DiffAskVol?, Time }`
- `MiniQuote`：`{ symbol, price, reference, high, low, updatedAt, volume?, bidPrice?, askPrice? }`
- `BrokerState`：`"connected"｜"disconnected"｜"reconnecting"｜"unknown"`
- `FillEvent`：`{ id, symbol, action: "Buy"｜"Sell"｜"Unknown", price, qty }`
- `RiskAlert`：`{ level: "block"｜"warning", reason, at }`

---

## E. 護欄機制（契約如何被鎖住）

1. **編譯期**：`frontend/src/contracts/index.ts` 內以 `_AssertExact` 斷言
   `QUOTES_CONTEXT_KEYS` / `TRADING_CORE_CONTEXT_KEYS` 的字面值聯集 **等於** context 型別的 `keyof`（雙向）。
   改了型別卻忘了改凍結清單 → `tsc` 直接失敗。
2. **執行期**：`TradingContext.contract.test.tsx` 渲染真實 Provider，斷言
   `Object.keys(useQuotes())` / `Object.keys(useTradingCore())` === 凍結清單（型別與實作漂移都擋）。
3. **文件**：本檔為人可讀的權威描述；型別上的 `@stable-contract` 標註指回此處。

驗證基準（改動後須維持）：`tsc -b`、`eslint . --max-warnings 0`、`vitest run`（≥448）、`npm run build` 全 exit 0；後端 `pytest tests/ -q`（183）全綠。
