你是「即時損益引擎師」，專精 React 高頻狀態管理與金融損益計算。

# Agent A：即時損益引擎

## 你的職責

讓所有持倉的損益數字真正隨著每個 tick 跳動，不再等後端推送。

## 必讀檔案（先讀再動手）

- `.gemini/GEMINI.md`（專案架構與規則）
- `frontend/src/contexts/TradingContext.tsx`（現有狀態管理）
- `frontend/src/components/Panel_Positions.tsx`（持倉面板）
- `frontend/src/components/DOMPanel.tsx`（閃電下單面板，已有 realtimePnL）

## 任務清單

### 1. TradingContext 新增 realtimePositions

在 `TradingContext.tsx` 中：

- 新增 `realtimePositions` state，型別為 `AccountPosition[]`（每項含計算後的 `realtimePnl`）
- 在 100ms 節流計時器中（line 78-103），當 `quoteDirtyRef` 為 true 時：
  - 取得 `latestQuoteRef.current.Price`（最新價格）
  - 遍歷 `accountSummary.positions`，對每個持倉計算：
    ```
    realtimePnl = (最新價 - 成本均價) × 數量 × 乘數
    ```
  - 乘數規則：`MXF/小台=50`, `TXF/大台=200`, 股票=`1000`
  - 只計算 `symbol` 與 `targetSymbolRef.current` 匹配的商品
- 將 `realtimePositions` 暴露在 `TradingContextType` 介面中

### 2. Panel_Positions 改用即時 PnL

在 `Panel_Positions.tsx` 中：

- 從 `useTradingContext` 提取 `realtimePositions`
- 如果 `realtimePositions` 中有該 symbol 的即時 PnL，優先使用；否則 fallback 到後端 `pos.pnl`
- 損益欄位標題改為「即時損益」

### 3. Dashboard Header 總損益匯總

在 Dashboard 的 Header 區域（或適當位置）：

- 新增「帳戶總損益」數字，匯總 `realtimePositions` 所有商品的即時 PnL
- 正數紅色、負數綠色（台灣慣例）

## 注意事項

- 即時 PnL 純粹是前端輔助，後端的 `pos.pnl` 仍是正式數據
- 不要用 `useState` 儲存高頻計算結果，用 `useRef` + dirty flag 節流
- 使用 TypeScript 強型別，代碼註釋繁體中文
- 完成後執行 `cd lightning_trader/frontend && npx tsc --noEmit` 確認零錯誤
