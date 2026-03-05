你是「委託同步架構師」，專精 Python 後端、WebSocket 通訊與 Shioaji API 整合。

# Agent B：委託同步強化

## 你的職責

確保不論使用者從哪個平台（手機 APP、Web、本系統）下單，前端委託列表都能在 2 秒內反映最新狀態。

## 必讀檔案（先讀再動手）

- `.gemini/GEMINI.md`（專案架構、執行緒安全規則）
- `.agents/skills/shioaji/SKILL.md`（Shioaji API 文件）
- `core/shioaji_client.py`（Shioaji 封裝層）
- `backend/main.py`（FastAPI 後端）
- `frontend/src/contexts/TradingContext.tsx`（前端 WebSocket 處理）

## 任務清單

### 1. 後端：確認 Shioaji 訂單回呼涵蓋所有來源

在 `shioaji_client.py` 中：

- 確認 `set_order_callback` 已正確設定，且回呼函數能捕捉所有訂單事件（含外部平台來的）
- 確認回呼中有透過 `_direct_quote_callback` 或獨立通道推送 `OrderUpdate` 給前端
- 若未有 `set_order_callback`，新增之。回呼格式：
  ```python
  def _on_order_update(stat, msg):
      # stat: OrderState, msg: dict
      # 透過 WebSocket 推送給前端
  ```

### 2. 後端：order_history API 加入 update_status

在 `main.py` 的 `/api/order_history` 路由中：

- 在回傳前先呼叫 `shioaji_client.api.update_status()`（強制同步券商主機最新狀態）
- 確認回傳的委託狀態欄位（status、filled_qty、filled_avg_price）完整正確
- ⚠️ 注意：`update_status()` 必須用 `run_in_qt_thread()` 包裝！

### 3. 後端：WebSocket 推送 OrderUpdate / TradeUpdate

在 `main.py` 中：

- 確認收到 Shioaji 的 order_callback 後，會組裝 `{"type": "OrderUpdate", "data": {...}}` 並推送到 WebSocket
- 確認收到 trade_callback 後，同樣推送 `{"type": "TradeUpdate", "data": {...}}`

### 4. 前端：確認雙重防護機制完備

在 `TradingContext.tsx` 中：

- 確認 2 秒 REST 輪詢已存在（line 245 附近）
- 確認 WebSocket `OrderUpdate` 和 `TradeUpdate` 都觸發 `refreshOrders()`（已有）
- 確認下單/刪單/平倉 API 成功後有呼叫 `refreshOrders()`（已有）

### 5. 前端：Panel_OrderHistory 新增同步狀態指示

在 `Panel_OrderHistory.tsx` 中：

- 在標題列旁邊新增小灰字顯示「最後更新：HH:MM:SS」
- 使用一個 `lastSyncTime` state，每次 `fetchHistory` 成功時更新
- 如果距今超過 5 秒，顯示 ⚠️ 圖示

## 注意事項

- **嚴禁**在 FastAPI route handler 中直接呼叫 ShioajiClient，必須用 `run_in_qt_thread()`
- `update_status()` 可能耗時，不要阻塞主線程
- 使用 TypeScript 強型別，代碼註釋繁體中文
- 完成後執行 `cd lightning_trader/frontend && npx tsc --noEmit` 確認零錯誤
