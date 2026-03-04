你是經驗豐富的全端開發師。請根據目前的專案架構，協助完成這最後一哩路的開發與版本發佈準備：

### 任務內容

1. **修改 `lightning_trader/frontend/src/contexts/TradingContext.tsx`**
   - 在 `TradingContextType` 介面中新增兩個方法：
     - `cancelOrder: (action: 'Buy' | 'Sell', price?: number) => Promise<void>`
     - `flattenPosition: (symbol: string) => Promise<void>`
   - 在 `TradingProvider` 中實作這兩個方法：
     - `cancelOrder`: 呼叫 API `POST /cancel_all`。傳入 `symbol`, `action`, `price` (若有)。成功後呼叫 `refreshOrders()` 或依據 response 更新 `workingOrders`。
     - `flattenPosition`: 呼叫 API `POST /flatten`。傳入 `symbol`。成功後等待 0.5 秒呼叫 `refreshOrders()` 以確保後端理帳同步。
   - 將這兩個方法傳入 `value` 物件暴露給整個 App。

2. **修改 `lightning_trader/frontend/src/components/Panel_Positions.tsx`**
   - 從 `useTradingContext` 提取 `flattenPosition`。
   - 將表格中的「平倉」按鈕邏輯修改為真正呼叫 `flattenPosition(pos.symbol)`。
   - 加入確認視窗 `window.confirm` 提示使用者。

3. **修改 `lightning_trader/frontend/src/components/Panel_OrderHistory.tsx`**
   - 從 `useTradingContext` 提取 `cancelOrder`。
   - 將「取消」按鈕邏輯修改為真正呼叫 `cancelOrder(t.action, t.price)`。
   - 加入確認視窗 `window.confirm` 提示使用者。

4. **版本升級與規範更新**
   - 將 `lightning_trader/frontend/package.json` 的版本號提升至 `1.0.11`。
   - 將 `design-system/lightrade/MASTER.md` 的版本聲明更新為 `V1.0.11`。

### 要求
- 嚴格遵守 **「後端唯一真相 (Strict Backend Truth)」**：所有 UI 更新必須在 API 成功回應並重新整理資料後發生。
- 使用 TypeScript 強型別，確保無 Lint 錯誤。
- 代碼註釋保持繁體中文。

請直接修改檔案，不需要詢問。完成後請回報修改完成。
