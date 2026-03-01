# LighTrade V2 PRO: 專業全端交易系統全面升級藍圖

這份藍圖旨在將 LighTrade 從一個基礎的看盤下單工具，徹底升級為具備**機構級 UI/UX**、**毫秒級帳務同步**以及**高階智慧單 (Algo Orders)** 的專業當沖/波段交易終端。

---

## 壹、 極致現代化 UI/UX 升級 (Professional UI/UX)

1. **模組化視窗架構 (Docking Layout)**
   - 擺脫單一固定畫面，引入類似專業終端（如 TradingView, XQ）的 Docking 系統。
   - 允許使用者自由拖曳、放大、縮小「閃電下單 (DOM)」、「持倉明細」、「今日委託」、「即時走勢圖」等面板。
   - 支援多螢幕操作，可將特定面板（如 DOM）獨立彈出為新視窗。

2. **戰鬥視覺與微交互 (Combat Visuals & Micro-interactions)**
   - **Tick Flash (跳動閃爍)**：報價更新時，該欄位會有短暫的毫秒級背景閃爍（紅漲綠跌），強化盤感。
   - **可視化持倉線 (Visual Position Line)**：在 DOM 價格列表中，不僅以顏色標註持倉均價，更拉出一條橫跨買賣欄位的半透明線，直覺顯示成本與市價的距離。
   - **大戶投/深色主題 (Dawho Dark Mode)**：全局套用高品質的 Navy (深藍) / Gold (金) 配色，降低長時間盯盤的視覺疲勞。

---

## 貳、 穩定且無縫的帳務與部位串聯 (Seamless Integration)

為了解決「畫面消失」或「切換商品時部位卡頓」的問題，我們必須重構資料流。

1. **全域狀態池與 WebSocket 雙向綁定 (Global State & WS Sync)**
   - **初始化載入**：登入時，後端一次性抓取所有股票/期貨的現有庫存與未成交委託，存入前端的 `TradingContext` (Global State)。
   - **事件驅動更新**：當訂單成交 (Filled) 或被刪除 (Cancelled) 時，後端透過 WebSocket 主動推送事件。前端接收後立刻更新 Global State，不需要重新發送 API 請求。
   
2. **極速本地端損益計算 (Zero-Latency PnL)**
   - **擺脫 API 輪詢**：未實現損益不再等待後端計算。
   - **邏輯**：前端已經擁有「持倉成本」與「持倉口數」。只要 WebSocket 收到新的即時報價 (Tick)，前端便在 `useMemo` 內使用公式 `(現價 - 成本) * 口數 * 乘數` 進行 1 毫秒內的重算。
   - **多商品無縫切換**：在 DOM 輸入不同商品代碼時，瞬間從 Global State 提取該商品部位，達成 0 延遲的面板切換。

---

## 參、 友善且完整的進階戰鬥功能 (Advanced Combat Features)

除了基礎的市價/限價單，我們將在前端與後端整合「智慧洗價引擎 (Smart Order Engine)」。

### 1. 智慧單系列 (Smart Orders)
*   **MIT (Market If Touched / 觸價單)**
    *   *情境*：突破追價或跌破停損。
    *   *操作*：在 DOM 上點擊「MIT」，然後在遠離當前市價的格子上點擊。系統不會立刻送單，而是由本地或後端監控，當市價觸及該價位時，瞬間打出市價單。
*   **Trailing Stop (移動停損單)**
    *   *情境*：讓獲利奔跑，回檔自動平倉。
    *   *操作*：設定「回檔 Ticks 數」。系統自動追蹤進場後的最高點(多單)或最低點(空單)。若價格從高點回落超過設定的 Ticks，系統自動市價平倉。
*   **OCO (One Cancels the Other / 二擇一單)**
    *   *情境*：進場後同時掛出「停利單」與「停損單」。
    *   *操作*：其中一邊成交時，系統會「自動刪除」另一邊的委託，避免變成反向開倉。

### 2. 極速部位管理 (Position Management)
*   **一鍵平倉 (Flatten All)**
    *   讀取當前該商品的「淨部位」(如多單 5 口)，點擊後系統自動送出「市價賣出 5 口」，並同時「刪除所有該商品的未成交委託」，確保乾淨出場。
*   **一鍵反向 (Reverse Position)**
    *   讀取當前「淨部位」(如多單 5 口)，點擊後系統自動送出「市價賣出 10 口」，瞬間讓部位由「多 5」翻轉為「空 5」。
*   **拖曳改單 (Drag & Drop)**
    *   將已經掛出的未成交委託 (顯示在 DOM 旁邊的小標籤)，用滑鼠按住拖曳到新的價格層次，放開後自動發送 `update_order` (改價) API。

---

## 肆、 開發執行時程表 (Implementation Roadmap)

為了確保穩定性，我們將分階段進行實作：

*   **Phase 1: 架構穩固與全域帳務 (Global Account & Stability)**
    *   優化 React `TradingContext`，確保 WebSocket 資料流不會造成畫面崩潰 (White Screen)。
    *   實作登入後自動載入所有歷史部位，並在前端完成各商品的「本地極速 PnL 計算」。
*   **Phase 2: UI/UX 與微交互 (Visual & Micro-interactions)**
    *   在 DOM 面板加入 Tick Flash (報價閃爍)。
    *   完善設定面板 (Settings Panel)，提供各類防呆機制的開關。
    *   實作 DOM 上的持倉成本線視覺化。
*   **Phase 3: 智慧單洗價核心 (Smart Order Engine)**
    *   在 FastAPI 後端實作獨立的非同步洗價執行緒 (Monitor Task)。
    *   前端 DOM 實作 MIT 與 Trailing Stop 的 UI 綁定。
    *   實作「一鍵平倉」與「一鍵反向」的複合 API。
*   **Phase 4: 模組化與進階管理 (Docking & OCO)**
    *   引入 React 拖曳模組，實作「拖曳改單」功能。
    *   實作 OCO 二擇一單邏輯。
    *   （選配）將整個前端介面改為可拖曳的 Docking Layout 架構。