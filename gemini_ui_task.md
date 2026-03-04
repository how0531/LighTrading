你是經驗豐富的全端開發師，精通 React, TailwindCSS, TypeScript 以及專業金融交易系統的前端 UI/UX 設計。你的設計風格承襲 Bloomberg Terminal 與 Dawho 的質感。

請協助我完成以下任務，並直接修改專案中的這三個檔案。

### 任務一：寫入核心交易準則 (Rules) 到 `design-system/lightrade/MASTER.md`
請在 `MASTER.md` 中尋找適當位置（建議在「禁止模式」區塊上方）新增一段 **「核心金融實作原則 (Core Trading Directives)」**：
1. **後端唯一絕對真相 (Strict Backend Truth)**：前端永遠禁止自行修改本地暫存或是猜測狀態（嚴格禁止樂觀更新 Optimistic UI）。任何委託與持倉的更新，必須來自後端 API 收到的 200 回應，或是完整的 WebSocket 確認快照。
2. **雙重保障同步 (Dual-Guard Synchronization)**：不可完全依賴 WebSocket 事件推播（外部系統有時會漏推）。必須配合背景定時輪詢（如 2 秒一次）或在操作後強制呼叫 API，確保狀態與交易所主機的一致性。
3. **直覺化圖形連結 (Visual Action & Context)**：純數字是不夠的，成本均價等狀態需要有視覺對應（例如報價列的持倉背景色塊與虛線）。持倉與委託列表應直接內建對應的「平倉」或「刪單」快捷操作按鈕。

### 任務二：優化 `lightning_trader/frontend/src/components/Panel_Positions.tsx` (即時持倉)
請對 `Panel_Positions.tsx` 進行深度 UI/UX 優化：
1. **視覺化損益底色**：在 `<tbody>` 的每一列 `<tr>`，依據 `pos.pnl` 給予整列極淡的背景色（例如：賺錢是大盤的紅色 `bg-red-500/10`，賠錢是綠色 `bg-green-500/10`）。讓整體盈虧一眼可見。
2. **快捷平倉按鈕**：在表格最右側新增一個「操作」欄位（`th` / `td`），放入小巧美觀的 `[平倉]` 按鈕（可先綁定 `alert('準備平倉 ' + pos.symbol)` 作為 UI 佔位符）。
3. **資料密度與對齊**：確保所有數字欄位使用 `.tabular-nums` 及 `font-mono` 對齊。可以考慮稍微減少 padding 讓介面更緊湊。

### 任務三：優化 `lightning_trader/frontend/src/components/Panel_OrderHistory.tsx` (今日委託)
請對 `Panel_OrderHistory.tsx` 進行深度 UI/UX 優化：
1. **無效代碼過濾防呆**：在渲染表格資料時，直接使用 `.filter(t => t.symbol && t.symbol.trim() !== "")` 過濾掉 `symbol` 是空字串的廢單資料。
2. **狀態標籤化 (Badge Status)**：將原本的 `getStatusColor` 純文字變色，升級成帶有背景色與邊框的精美 Badge (Tailwind 樣式)。例如：
   - Filled (成交): `bg-green-500/20 text-green-400 border border-green-500/30 rounded px-1.5 py-0.5 text-[10px]`
   - Cancelled (取消): `bg-slate-500/20 text-slate-400 border border-slate-500/30 ...`
   - Pending 系列: 黃色/橘色 Badge
   - Failed/Rejected: 紅色 Badge
3. **即時刪單按鈕 (Quick Cancel)**：如果狀態是未確認/未成交（例如 `PendingSubmit`, `PreSubmitted`, `Submitted`），在狀態列旁邊（或新增操作列），顯示一個明顯的 ✕ 按鈕，點擊彈出 `alert('準備刪除委託單')`。

請仔細閱讀原本的源碼，並使用你的專業技能完美修改這三個檔案！不需要詢問，直接操作修改。
