你是開發經驗豐富的全端工程師。請協助完成以下 UI 優化任務並發佈新版本：

### 任務內容

1. **修改 `lightning_trader/frontend/src/components/DOMPanel.tsx`**
   - 尋找渲染價格列表（Price Rows）的邏輯。
   - 在中央價格列（Price Column）中，如果該價位等於當前持倉的均價 (`isCostLine` 為 true)，請在價格旁邊或下方顯示一個明顯的標籤，例如：
     - `(Cost: 18450)` 或 `[COST]`
     - 樣式應簡潔且專業，例如：`text-[10px] bg-amber-500/20 text-amber-500 px-1 rounded ml-1`
   - 確保標籤不會破壞表格的橫向排版。

2. **版本升級與發佈**
   - 將 `lightning_trader/frontend/package.json` 的版本號提升至 `1.0.12`。
   - 將 `design-system/lightrade/MASTER.md` 的版本標示更新為 `V1.0.12`。

### 要求
- 保持 `font-mono` 與 `tabular-nums` 的一致性。
- 修改完成後，請直接將變更 `git add .`, `git commit -m "feat: display cost in price column and release V1.0.12"`, `git tag V1.0.12`, 並 `git push origin V1.0.12` 及 `git push origin main`。
- 修改時請確保不破壞既有的 `isCostLine` 背景色邏輯。

請直接執行修改並上傳，不需要進一步確認。完成後請回報執行結果。
