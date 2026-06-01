# 變更日誌 (Changelog)

所有關於 LighTrade 專案的重要版本更新與功能修正，將在此文件中持續記錄。

---

## [2.0.0] - 2026-06-02

### 🌟 重大優化與視覺重構

* **商品中文名稱高可用性 Fallback 機制**
  * 在後端 `accounts.py` 接口加入離線股票名稱對照資料庫，涵蓋永豐金 (2890)、台灣虎航 (6757)、第一金太空衛星 (00910)、敬鵬 (2355)、系統電 (5309)、台積電 (2330)、鴻海 (2317) 等常用標的。
  * **目的與設計**：當 Shioaji API 遭遇伺服器 `Too Many Connections` (451) 連線次數限制，或是網路瞬斷時，介面不再退回純代碼，而是會自動抓取離線字典對照，確保前端中文名稱完美顯示。
  * **線上線下聯集**：在 Shioaji 正常登入時，自動將線上搜尋與離線對照合併，以保障代碼的高解析度。

* **持倉與今日委託面板「中文大、數字小」排版**
  * 修改 `Panel_Positions.tsx` 與 `Panel_OrderHistory.tsx`，調整代碼欄視覺結構為「上方大字中文，下方小字等寬代碼」。
  * 自動過濾展示層中的 `TSE` 與 `OTC` 前綴（如 `TSE2890` 在介面上僅呈現為 `2890`），不影響底層交易送單邏輯。

* **DOM 面板成本價徽章設計優化**
  * 修正 `DOMTable.tsx`，將原有的 `[COST]` 標籤升級為中文「成本」微型圓角徽章，將中括號移除並微調字級至 `9px`，提升專業質感。

* **版面 Presets 切換功能修正**
  * 修改 `Dashboard.tsx` 與 `Header.tsx`，修正了右上角 Preset 選單切換無反應的缺陷。
  * 引入 `localStorage` 持久化快取機制，當使用者重新整理或重啟時，自訂的版面配置 (layout) 與專注模式 (focusMode) 皆能正確保留。

### 🐛 Bug 修正與效能改善

* **Shioaji 遍歷股票合約 Bug 修正**：
  * 修復了 `core/shioaji_client.py` 搜尋中直接迭代 `api.Contracts.Stocks` 的異常（Shioaji 官方不支持直接 iterator）。
  * 針對純數字搜尋，增加 `api.Contracts.Stocks.get(code)` 的精確快速查詢通道，大幅改善搜尋股票時造成的後端異常。
* **React Fetching 鎖死 (Race Condition) 修正**：
  * 優化前端中文獲取邏輯，確保在 WebSocket 還未登入完成時的查詢失敗，不會將 fetchingRef 鎖死；在後端登入成功後，前端會自動補發查詢以重新拉取中文名稱。
* **Uvicorn 重啟調校**：
  * 調校後端啟動指令與 log 選項，加強 UTF-8 編碼處理以避免 Windows Console 下的 Unicode 顯示亂碼。
