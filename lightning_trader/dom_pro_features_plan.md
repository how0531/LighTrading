# LighTrade: 專業級閃電下單 (DOM) 18 項進階功能實作藍圖

此文件針對機構/專業當沖交易員所需的 18 項 DOM 特性，進行深度架構拆解，並明確定義前後端的協作方式與對應的 Shioaji API 函數。本藍圖作為 Gemini CLI (輔助 AI) 執行開發任務的最高指導原則。

---

## Phase 1: 高速操作與沉浸視角 (前端重點)

這些功能主要專注於純 UI/UX 邏輯，大幅提升單擊、熱鍵與數量的反應速度。原則上不需動用複雜的 Shioaji 下單 API 修改。

1.  **鍵盤熱鍵支援 (Global Hotkeys)**
    *   **目標**: 在 `DOMPanel.tsx` 綁定全局 `keydown` 事件。支援 `Space` 置中、方向鍵上下移動聚焦、`Esc` 取消全部。
    *   **實作細節**: 使用 `useEffect` 掛載 `window.addEventListener`，管理 Focus 狀態。
2.  **一鍵置中 (Center to Last Price)**
    *   **目標**: 當前價格超出可視範圍時，立刻捲動置中。
    *   **實作細節**: 利用 React `useRef` 錨定 `currentPrice` 所在的 `<tr>`，呼叫 `el.scrollIntoView({ behavior: 'smooth', block: 'center' })`。
3.  **快速數量切換盤 (Quick Quantity Keypad)**
    *   **目標**: `[1]`, `[5]`, `[10]` 的快速按鈕群取代輸入框。
    *   **實作細節**: 擴充 `DOMPanel` 狀態，點擊後直接更新 `qty` state。
4.  **戰鬥模式開關 (Combat Mode Toggle)**
    *   **目標**: 切換滑鼠單擊 DOM 時，是否直接送單，或者跳出確認對話框。
    *   **實作細節**: 增加 `isCombatMode` 狀態；關閉時攔截 `handlePlaceOrder`，改為顯示 Modal。
5.  **大單暴現特效 (Large Print Flash)**
    *   **目標**: 單筆 Tick 成交量超過 50 口時，畫面邊框黃色閃爍。
    *   **實作細節**: 在 `TradingContext` 收到 `Tick` websocket 事件時，若 `volume > 50`，更新 `flash` 狀態，觸發 Tailwind animate 類別。
6.  **檔位合併縮放 (Price Grouping)**
    *   **目標**: 提供 1x, 5x, 10x 縮放，將五檔價格以距陣方式合併計算。
    *   **實作細節**: 前端將收到的 `BidAskPrice` 序列化處理，每 5 階加總 Volume，減少 DOM 高度。

---

## Phase 2: 庫存與損益整合 (Shioaji API - 帳務與改單)

此階段開始深入後端，結合實際帳戶狀況，投射在下單介面上。

7.  **拖曳改單 (Drag & Drop Modification)**
    *   **目標**: 將某階的委託量拖曳至另一階，完成改單。
    *   **Shioaji API**:
        1.  先取得該掛單物件 `trade = api.list_trades()` 找出狀態為 Pending/Submitted 的。
        2.  呼叫 `api.update_order(trade=trade, price=new_price)`。
    *   **後端新增**: `/api/update_order` endpoint。
8.  **當前淨部位指示器 (Net Position Indicator)**
    *   **目標**: 在 DOM 上方顯示多空口數。
    *   **Shioaji API**: `positions = api.list_positions(api.stock_account)`，撈取 `position.quantity` 與 `position.direction`。
9.  **DOM 上的持倉均價線 (Position Average Line)**
    *   **目標**: 特殊背景色標示成本價。
    *   **Shioaji API**: 由上述 `positions` 獲取 `position.price` (均價)，回傳前端渲染。
10. **浮動未實現損益顯示 (Floating Unrealized PnL)**
    *   **目標**: 即時跳動賺賠金額。
    *   **Shioaji API**: `pnls = api.list_profit_loss(api.stock_account)`，將此數據打包透過 WebSocket 推播。
11. **一鍵反向 / 一鍵平倉 (Reverse & Flatten) & 分批出場**
    *   **目標**: 結合取消全部與反向市價單。
    *   **Shioaji API**: `api.cancel_order()` 遍歷所有未成單，再依照對應部位大小計算（如總量的一半）送出 `api.place_order(action=Action.Sell, qty=pos.quantity)`。

---

## Phase 3: 行情深度加總與智慧策略 (後端進階計算)

這是最硬核的一級戰區，需要建立後端本地的 Memory State 以跨越 API 限制。

12. **掛單附帶停損停利 (OCO Bracket Orders)**
    *   **目標**: 買單成交時，自動掛出停損掛停利。
    *   **Shioaji API**: 擴充目前的 `shioaji_client.smart_orders` 列表。一旦收到成交回報 `api.set_order_callback`，立即注入兩筆新的本地觸發紀錄。
13. **開啟移動停損 (Trailing Stop Toggle)**
    *   **目標**: 獲利自動向上移動停損線。
    *   **實作細節**: 已經初步在 `shioaji_client._check_smart_orders` 中寫了高低點追蹤，需與前端綁定 UI 並動態啟動。
14. **冰山委託隱藏 (Iceberg Orders)**
    *   **目標**: 大單切碎分批丟出。
    *   **Shioaji API**: 後端使用 `asyncio` Task 管理。假設丟 100 口顯示 10 口，當前 10 口的 trades status 變為 Filled 後，程式自動再次觸發 `api.place_order(qty=10)`。
15. **當日高/低/開盤價標記 (Day High/Low/Open Markers)**
    *   **目標**: DOM 旁標注極值。
    *   **Shioaji API**: `snap = api.snapshots([contract])[0]`。提取 `snap.high`, `snap.low`, `snap.open`。透過 Websocket 的 `BidAsk` 封包攜帶給前端。
16. **價量累積分布圖 (Volume Profile Overlay)**
    *   **目標**: 長條圖背景顯示密集交易區。
    *   **實作細節**: 後端全域宣告 `volume_profile: dict`，每當 `on_quote` 收到 `Tick`，執行 `volume_profile[tick.price] += tick.volume`。定時推給前端 `DOMPanel` 繪圖。
17. **預計排隊位置推算 (Estimated Queue Position)**
    *   **目標**: 算前面還有幾口排隊。
    *   **實作細節**: 紀錄掛單當下那一層的 `BidVolume` 總量。只要該層未破底，隨後出現的 `Tick` 成交量就慢慢從排隊總量中扣除，公式大致為 ` Queue = Initial_Vol - sum(tick.vol)`。

---

## 給 Gemini CLI (AI Agent) 的行動指令

我們將按照階段分派任務給 Gemini CLI 進行開發。
**首要重點目標**: 請先專注於 **Phase 1** 建立前端的高速戰鬥體驗，並挑選 **Phase 2 的持倉與未實現損益 (Position/PnL)** 進行後端 Shioaji API 的整合。
因為有了庫存與損益，閃電下單的實質應用才算圓滿。
