# LighTrade Backlog

未來的優化候選清單。**順序按「使用者價值 / 實作成本」粗排**。

如果你（user）下次叫我「繼續開發」沒指定方向，我會從上往下抓一條開做。
如果你想 deprioritise / 加新項目，直接編輯這個檔案即可。

---

## 高槓桿（user-visible，每條 ~半天）

### B1 — 多帳戶聚合視圖
- **問題**：使用者有多個 Shioaji 子帳號（如自有 + 法人），目前一次只能看一個 active account 的損益/持倉
- **方案**：Header 加「合併」切換 → backend 在 `list_positions` 已遍歷所有 account，前端把 `accountSummary.positions` 不再依 active 切，而是顯示全部
- **影響檔**：`backend/routers/accounts.py`、`Panel_Positions.tsx`、`Header.tsx`

### B2 — 一鍵 SIM ⇄ LIVE 切換
- **問題**：切換必須 logout、改 .env、重啟。實際當沖 user 想白天 SIM 練手、晚上 LIVE 跑單
- **方案**：Header 加 toggle；後端 `POST /api/login` 已支援 alread-logged-in 偵測；只需另開一個 `POST /api/relogin` 帶新的 simulation flag、強制 logout + login
- **風險**：Shioaji session 切換需小心；要確認 contracts cache 被清

### B3 — 訂單延遲量測即時顯示
- **資料源**：backend 已記 `last_message_age_s`（in /api/metrics），但下單→fill 的端到端延遲沒被記
- **方案**：bridge.on_shioaji_order_update 收 Filled 時，把 `now - place_time` 寫進 in-memory ring buffer；新端點 `/api/metrics/latency` 暴露 P50/P95；Header 角落小顯示

### B4 — 每商品自訂預設口數
- **問題**：1-9 hotkey 設口數對股票（萬張）與期貨（單口）需求不同
- **方案**：Settings 加 per-symbol 預設 qty map，subscribe 切商品時自動套用

### B5 — Telegram / Discord 通知 webhook
- **問題**：使用者離開電腦 → 大成交 / 停損觸發沒人知道
- **方案**：Settings 加 webhook URL 欄位；backend 在 Filled / risk_breach 時送 POST。需考慮 secret 不外洩

---

## 中槓桿（基建/品質，每條 1-2 天）

### B6 — Playwright E2E
- **問題**：所有測試都是單元測；沒有「登入→訂閱→下單→刪→平倉」的 golden path 覆蓋
- **方案**：mock backend（用 Pydantic 模型反推固定回應）+ Playwright 跑 5-10 個場景；加進 desktop-smoke workflow

### B7 — 跨日歷史 fills 匯入
- **問題**：journal 從 Sprint 14 才開始記錄，之前的歷史成交沒在 DB
- **方案**：`POST /api/journal/import` 接 CSV upload（與 Sprint 9 的 daily_report CSV 同 schema），把過往資料補進 SQLite

### B8 — Backend log rotation
- **問題**：uvicorn 自己的 log 沒輪替（Sprint 10 R7b 只搞了 Electron 端的 backend.log）
- **方案**：lifespan 內掛 logging.handlers.TimedRotatingFileHandler 到 `~/.lightrade/logs/backend-YYYYMMDD.log`，保留 30 天

### B9 — 可拖曳的 DOM ladder 中心線
- **問題**：DOM 預設中心是 reference price；trader 想要的可能是「成本價」或「目標價」
- **方案**：DOMPanel 加可拖曳 anchor，影響 `priceBase`

### B10 — 自選清單跨裝置同步
- **問題**：watchlist 存 localStorage，多裝置不同步
- **方案**：Sprint 12 已有 `watchSymbols` action；加 backend `/api/user_settings.watchlist` 持久化，登入後拉回

---

## 低槓桿 / nice-to-have

- **B11**：K 線加 RSI/MACD（lightweight-charts 支援 area series）
- **B12**：DOM 高頻成交「大單閃光」（>50 口 / 大額 → 1 秒金色閃）
- **B13**：操作節奏統計（每分鐘下單數、最快兩單間隔）
- **B14**：本地 alert 系統（價格穿越線觸發 toast / 系統通知）
- **B15**：交易日誌可加備註（per-fill notes 存 SQLite 同 schema 加 `notes TEXT`）
- **B16**：暗色 / 明色主題切換（Settings 已有欄位但沒實作）

---

## 已完成（Sprint 0–18 的脈絡備忘）

|Sprint|主題|PR|
|---|---|---|
|0| 資料同步骨幹（PnL/外部單同步/DOM race）| #1|
|1| 風控 + 安全| #1|
|2| Toast / hotkey hint| #1|
|3| 結構維護性| #1|
|4| 測試基線| #1|
|5| Production hardening| #1|
|6| Feature depth (margin / batch cancel / symbol search)| #1|
|7| DevOps (README / Docker / CI / pre-commit)| #1|
|8| Test coverage 擴張| #1|
|9| Electron 桌面 + auto-update| #3|
|10| Polish 9 輪| #4|
|11| K 線圖 + 4 timeframes| #5|
|12| Watchlist 側欄| #6|
|13| Smart orders REST + panel + trailing form| #7|
|14| SQLite trade journal| #8|
|15| Equity curve (FIFO)| #9|
|16| Stats panel (win rate / PF / drawdown)| #10|
|17| K 線 MA20/MA60/VWAP| #11|
|18| Hotkey cheat sheet + 此 BACKLOG| #12 (this PR)|
