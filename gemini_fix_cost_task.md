你是經驗豐富的全端開發師。使用者回報在 V1.0.12 中「沒看到」[COST] 標籤，請檢查並修復。

### 診斷與修復建議

1. **檢查 `lightning_trader/frontend/src/components/DOMPanel.tsx`**
   - **CSS 問題**：目前的 `[COST]` 標籤使用 `absolute left-full`，但其父層 `<td>` (約在 717 行) 使用了 `overflow-hidden`。這可能導致標籤被裁切而看不見。
   - **解決方案**：不要使用 `absolute left-full`。請將 `[COST]` 標籤直接放在價格 `formatPrice` 的後方，作為 Flex 佈局的一部分。例如：
     ```tsx
     <span className="z-10 flex items-center justify-center ...">
       {formatPrice(p, targetSymbol)}
       {isCostLine && (
         <span className="text-[10px] bg-amber-500/20 text-amber-500 px-1 rounded ml-1 font-bold whitespace-nowrap border border-amber-500/30">
           [COST]
         </span>
       )}
     </span>
     ```
   - **邏輯檢查**：確保 `isCostLine` 的比對邏輯足夠寬鬆，能涵蓋非跳動點整數的持倉均價。目前的 `Math.abs(p - currentPosition.price) < (getTickSize(p, targetSymbol) * 0.5)` 應該可行，但請確認 `currentPosition` 物件是否真的有傳入且資料正確。

2. **版本升級與發佈**
   - 將 `lightning_trader/frontend/package.json` 的版本提升至 `1.0.13`。
   - 將 `design-system/lightrade/MASTER.md` 的版本標示更新為 `V1.0.13`。

### 要求
- 確保 `[COST]` 標籤非常醒目，且不會被裁切。
- 修改完成後，請執行 `git add .`, `git commit -m "fix: ensure [COST] label is visible and release V1.0.13"`, `git tag V1.0.13`, 並推送到 GitHub (`git push origin V1.0.13`, `git push origin main`)。

請直接執行修改並上傳，不需要進一步確認。完成後請回報執行結果與修復原因。
