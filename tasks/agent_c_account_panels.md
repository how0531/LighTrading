你是「帳務面板開發師」，專精 React 元件開發與金融資料視覺化。

# Agent C：帳務面板開發

## 你的職責

為交易員打造一站式的財務全貌面板，新建兩個元件並整合到 Dashboard。

## 必讀檔案（先讀再動手）

- `.gemini/GEMINI.md`（專案架構與設計規範）
- `design-system/lightrade/MASTER.md`（色彩、字體、設計原則）
- `frontend/src/components/Panel_Positions.tsx`（參考現有面板風格）
- `frontend/src/components/Dashboard.tsx`（主畫面佈局！確認在哪裡新增面板）
- `frontend/src/api/client.ts`（API 呼叫封裝）
- `frontend/src/index.css`（全域樣式 / glass-panel 類別）

## 任務清單

### 1. 新建 `Panel_AccountBalance.tsx` — 帳戶餘額面板

- 呼叫 `/api/account_balance` 取得資料
- 每 5 秒輪詢一次
- 顯示：
  | 欄位 | 說明 |
  |------|------|
  | 總權益 (Equity) | `equity` |
  | 可用保證金 | `margin_available` |
  | 已用保證金 | `margin_required` |
  | 維持率 | `margin_available / margin_required * 100%` |
- 維持率 < 100% 時用紅色警告底色
- 設計風格：與 `Panel_Positions` 一致（`.glass-panel`、`tabular-nums`、`font-mono`）

### 2. 新建 `Panel_TradeHistory.tsx` — 成交明細面板

- 呼叫 `/api/order_history` 取得資料
- 只顯示 `status === 'Filled'` 的委託
- 欄位：成交時間、商品、方向（買/賣）、成交均價、成交量
- 排序：最新成交在最上面
- 設計風格：表格密度與 `Panel_OrderHistory` 一致

### 3. Dashboard 整合

- 在 `Dashboard.tsx` 中引入兩個新面板
- 放在合適的 Grid 位置（Panel_Positions 下方或右側）
- 確保 responsive layout 不會破版

### 4. Dashboard Header 今日損益摘要

在 Dashboard 的 Header 區域新增三欄損益摘要：

```
已實現損益: +12,500     未實現損益: -3,200     當日合計: +9,300
```

- **已實現損益**：來自 `accountSummary["參考損益"]` 或後端今日平倉資料
- **未實現損益**：來自 `realtimePositions` 的即時 PnL 合計（依賴 Agent A 完成後的介面）
  - 如果 Agent A 尚未完成，先用 `accountSummary.positions` 的 `pnl` 合計作為 fallback
- **當日合計**：已實現 + 未實現

## 注意事項

- 新元件必須 `export default`
- 所有數字欄位使用 `tabular-nums font-mono` 對齊
- 台灣慣例：紅色=正/賺錢，綠色=負/虧損
- 使用 TypeScript 強型別，代碼註釋繁體中文
- 完成後執行 `cd lightning_trader/frontend && npx tsc --noEmit` 確認零錯誤
