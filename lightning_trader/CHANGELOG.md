# 變更日誌 (Changelog)

所有關於 LighTrade 專案的重要版本更新與功能修正，將在此文件中持續記錄。

---

## [2.2.0] - 2026-07-04

### 🔄 外部管道下單即時同步（委託對帳迴圈）

* **問題**：Shioaji 只推播「本 session 下的單」。從券商 App / 其他 API session 下單，
  這裡的介面看不到委託即時出現（要等前端 5 秒輪詢），外部「成交」更是完全
  進不了 journal——交易日誌、已實現損益、風控熔斷全部漏算外部管道。
* **新增 `backend/services/order_sync.py`**：背景迴圈（預設每 2.5 秒，
  `LIGHTRADE_ORDER_SYNC_INTERVAL` 可調，0=停用）向券商 `update_status` + `list_trades`：
  - 活躍委託快照有變化 → 直接推播 `WorkingOrdersSnapshot` 給前端
    （沿用 snapshot seq 防亂序，前端不用再打 REST），外部掛單/刪單 ~2.5 秒內出現
  - 對帳出 journal 沒有的成交（id = ordno#seq，與 callback 路徑天然去重）→
    補進 journal、觸發已實現損益重算、作廢持倉快取、推播 `TradeUpdate`
    （前端成交通知）、發射 `on_fill`（Bracket 母單在 callback 漏接時的補償）
* **快照 builder 三處合一**：orders.py / accounts.sync_all / 對帳迴圈共用
  `build_working_orders`（之前各自複製一份）。
* 前端 `TradingContext` 新增 `WorkingOrdersSnapshot` 訊息處理（直接套用快照）。
* 測試：後端對帳（外部委託推播 / 外部成交入帳 / 指紋與 id 去重 / 外部刪單）
  + 前端快照套用與 seq 防亂序，共 +4。

---

## [2.1.0] - 2026-07-03

### 🛡️ 資金安全（P0）

* **日虧損熔斷修復**：原本 `max_daily_loss` 依賴從未被餵入資料的 OrderManager 事件鏈，生產環境永遠不會觸發。現在由真實路徑餵入：未實現損益來自 `pnl_broadcaster`（不依賴 WS 連線）、已實現損益來自成交 journal 的當日 FIFO 重算（`order_guard.refresh_daily_realized`）。
* **所有下單路徑過風控**：`/reverse`（雙倍市價單）與智慧單觸發原本完全繞過 RiskManager，現在統一前置檢查。政策：保護性出場（一鍵平倉、平既有部位的停損觸發）即使熔斷後仍放行，只封鎖開新倉。
* **股票停損 NameError 修復**：`shioaji_client.place_order` 使用了未 import 的 `StockOrderLot/StockOrderCond`，導致股票的 flatten / reverse / 智慧單觸發會直接 crash（停損不會執行）。
* **智慧單 SQLite 持久化**：停損 / 移停 / OCO / Bracket 落地 `~/.lightrade/smart_orders.db`，backend 重啟自動 re-arm（移停 watermark 重啟後從當下市價重新追蹤）。
* **市價單 confirm 流程補齊**：WARNING 級檢查（市價單 / 價格偏離 / 反向）回 409 `CONFIRM_REQUIRED` + warnings 清單，前端確認後帶 `confirm: true` 重送；原本 WARNING 一律 422、市價單經正規路徑永遠送不出去。
* **可選 API Token 認證**：`LIGHTRADE_API_TOKEN` 設定後，所有 `/api`（除 health）需帶 `X-API-Token`、WebSocket 需帶 `?token=`。Docker / LAN 部署建議必開。
* **LIVE 自動登入改為 opt-in**：`SIMULATION` 預設改回 true（與文件一致）；`SIMULATION=false` 時需 `LIGHTRADE_ALLOW_LIVE_AUTOLOGIN=true` 才會開機自動登入真實帳戶。
* **Bracket 子單修復**：`on_fill` 事件現在由 bridge 從真實成交回報發出（原本只有死掉的 OrderManager 會發，bracket 停利停損永遠不會啟動）。
* **.env 變數名對齊**：`API_KEY/SECRET_KEY/SIMULATION`（文件版）與 `SHIOAJI_*`（舊程式版）皆支援——原本 config 只讀 `SHIOAJI_*`，照文件設定的 .env 實際上不生效。

### ⚡ 延遲與架構（P1）

* **event loop 不再被券商呼叫卡死**：`run_in_qt_thread` 名為執行緒橋接、實為同步直呼，登入/下單/搜尋全卡在 asyncio loop 上。改為真正的單 worker `broker_executor`（`run_in_broker_thread`），報價與 PnL 推送不再受券商 RTT 影響。
* **智慧單觸發移出行情執行緒**：觸發判斷仍在 tick 回呼（快），實際下單 dispatch 到 broker thread；`_smart_orders` 加 RLock。
* **tick 雙重發射修復**：`on_tick` 原本在 shioaji_client 與 bridge 各發一次，所有消費者每 tick 處理兩遍；統一由 bridge 單點發射。
* **重連補訂閱**：斷線重連原本只還原主商品，持倉/自選的背景訂閱全部丟失（PnL 無聲變舊）；現在全部補回。
* **期貨乘數表統一**：原本 4 份複製且數值不一致（不同路徑算出不同損益），收斂到 `backend/services/contract_specs.py`。
* **移除 PyQt5 依賴與死碼**：刪除 legacy/ PyQt 桌面版與 OrderManager / PositionTracker / HotkeyManager / WatchlistManager / SoundManager（後端無任何路徑使用；watchlist_manager 的頂層 PyQt5 import 甚至讓 Docker 容器無法啟動）。`requirements_backend.txt` 移除 pyqt5、補 `python-multipart`、shioaji 加上界 `<2.0`。

### 🧪 測試與 CI（P2）

* **新增 FastAPI TestClient 整合測試**（`tests/test_api_integration.py`，fake shioaji SDK）：confirm 流程、風控封鎖、flatten NameError 回歸、reverse 部位上限、智慧單觸發風控（開倉封鎖/保護放行）、日虧損熔斷、journal 已實現餵入、API token 認證。
* **新增 SmartOrderEngine 單元測試**（`tests/test_smart_order_engine.py`）：MIT/移停/OCO/Bracket 觸發邏輯 + 持久化 re-arm。
* **CI 強化**：vitest 進主 CI、ESLint 轉硬性擋 PR、backend 改從 requirements 安裝、新增 dependabot、補上缺失的 `.secrets.baseline`。
* **基礎設施**：docker-compose `depends_on` 改 `service_healthy`；刪除孤兒 `lightning_trader/electron/`；backend Dockerfile 不再需要 pyqt5 過濾。

### 🖥️ 前端

* **TradingContext 拆分高頻/低頻雙 context + memoized value**：低頻消費者（帳戶/持倉/委託面板）不再於行情活躍時每 100ms 全部重繪；DOM ladder `React.memo` 化。
* **每個 dashboard 面板獨立 ErrorBoundary**：單一面板崩潰不再炸掉整個交易畫面。
* **下單 confirm 重送流程 + API token 支援**（設定視窗可填 token）。
* **WS 重連加 jitter、訂單刷新輪詢整併降頻**；共用 playSound / API error / URL 解析工具。

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
