# LighTrade Backlog

未來的優化候選清單。**順序按「使用者價值 / 實作成本」粗排**。

如果你（user）下次叫我「繼續開發」沒指定方向，我會從上往下抓一條開做。
如果你想 deprioritise / 加新項目，直接編輯這個檔案即可。

> 2026-05 對帳：原始 B1–B16 大多已在 Sprint 19–33 完成，本檔已更新為真實狀態。

---

## 仍開放（autonomous 不宜直接做，需你決策 / 監督）

### B2 — 一鍵 SIM ⇄ LIVE 切換  ⏳ OPEN
- **問題**：切換需 logout、改 .env、重啟。當沖 user 想白天 SIM 練手、晚上 LIVE 跑單
- **方案**：Header toggle → 後端 `POST /api/relogin` 帶 simulation flag、強制 logout+login、清 contracts cache
- **為何未做**：涉及 Shioaji session 切換與**真實下單帳號**，無實盤環境無法安全驗證；建議在你監督下進行，不適合 autonomous sprint

### B6 — Playwright E2E  ⏳ OPEN
- **問題**：全為單元測，缺「登入→訂閱→下單→刪→平倉」golden path
- **方案**：mock backend + Playwright 5–10 場景，加進 desktop-smoke workflow
- **為何未做**：屬大型基建（新測試框架 + CI 流程），宜獨立規劃一個完整 sprint

### B16 — 暗 / 明色主題切換  ⏳ OPEN（成本被低估）
- **現況**：`Settings.theme` 欄位與 `SettingsContext` 的 `documentElement` class 切換都在，但**全 codebase 0 個 `dark:` variant**，顏色全為 hardcoded slate + 單一暗色 CSS 變數
- **為何未做**：要做出真正可用的明色主題＝重建整套 light 色票並逐一驗證 ~25 個 component，屬大規模改版而非開關，需專案級規劃

---

## 看盤環境（Sprint 34）

| 主題 | 內容 |
|---|---|
| 多圖看盤 | `MultiChartPanel` 1/2/4 宮格,每格獨立商品 + 週期;`ChartPanel` 重構支援 `symbol`/`compact` props |
| 報價看板 | `QuoteBoardPanel` 全寬報價矩陣（成交/漲跌/幅%/高低/總量/委買賣),可排序、點列切換主商品 |
| 指標擴充 | `indicators.ts` 新增 EMA / 布林通道(BB);ChartPanel 加 EMA20 / BB toggle |
| 版面整合 | Dashboard 由 3 面板回復為 13 面板(含 quotes/mchart);新增「看盤」preset |
| 訂閱模型 | TradingContext 加 `setAuxWatch`,多圖與自選清單取聯集互不覆蓋;MiniQuote 加 volume/bid/ask |

> 動機:使用者反饋欠缺看盤環境,並提及 Sinotrade/shioaji-pro-app。該專案為 **AGPL-3.0,僅作功能參考、未引用任何原始碼**,全部以既有技術棧原生重實作。

---

## 看盤環境（Sprint 35）

| 主題 | 內容 |
|---|---|
| 逐筆成交 / Time & Sales | 新增 `TimeSalesPanel`（tape）,顯示時間/成交/量/內外盤,資料源 `quoteHistory` |
| 內外盤判定 | `tickFlow.ts: classifyAggressor` 依 Shioaji TickType(1=外盤買/2=內盤賣),0/未知時用價格推估 |
| 大單偵測 | `tickFlow.ts: isBigTrade`,門檻可調並存 localStorage（與 DOM 大單門檻一致預設 50）|
| 買賣力道彙總 | `tickFlow.ts: summarizeFlow` 計算外/內盤量、delta、buyPct,面板底部力道條 + Δ |
| 版面整合 | Dashboard 由 13 面板擴為 14(新增 tape);三個既有 preset（當沖/波段/看盤）皆加入 tape |

---

## 已完成（Sprint 19–33）

| 項 | 主題 | 落地 |
|---|---|---|
| B1 | 多帳戶聚合視圖 | 早期 sprint |
| B3 | 訂單延遲量測 | `latency_tracker` + Header 顯示 |
| B4 | 每商品自訂預設口數 | `qtyBySymbol` |
| B5 | Telegram/Discord webhook | Sprint 22 `alert_dispatcher` |
| B7 | 跨日歷史 fills CSV 匯入 | Sprint 24 |
| B8 | Backend log rotation | Sprint 21（`TimedRotatingFileHandler`，14 天）|
| B9 | DOM ladder 置中錨點 | **Sprint 33**（現價/成本錨點；priceBase 重建為穩定性刻意不做，改捲動錨點）|
| B10 | 自選清單跨裝置同步 | Sprint 23 |
| B11 | K 線 RSI | Sprint 25 |
| B12 | DOM 大單閃光 | `DOMTable` `isBigTrade` ring/glow/pulse |
| B13 | 操作節奏統計 | Sprint 27 |
| B14 | 本地價格穿越警報 | Sprint 26 |
| B15 | 交易日誌 per-fill 備註 | Sprint 32（tag + notes）|

## UX 優化提案（T1–T5，Sprint 28–32）

| 主題 | Sprint | 內容 |
|---|---|---|
| T1 智慧 Sizing | 28 | 張口/金額/%權益 三模式 + 隨價自動換算 |
| T2 PnL 淨值化 | 29 | 扣手續費+稅實拿、毛/淨切換 |
| T3 持倉脈絡 | 30 | 持有時間/距停損%/進場明細展開 |
| T4 版面 preset | 31 | 動能/當沖/波段 一鍵切版 |
| T5 紀律工具 | 32 | journal tag/notes、by_tag 篩選統計 |

## Sprint 0–18 脈絡備忘

|Sprint|主題|PR|
|---|---|---|
|0–8| 資料同步/風控/測試/Production/DevOps | #1|
|9| Electron 桌面 + auto-update | #3|
|10| Polish 9 輪 | #4|
|11| K 線圖 + 4 timeframes | #5|
|12| Watchlist 側欄 | #6|
|13| Smart orders REST + panel | #7|
|14| SQLite trade journal | #8|
|15| Equity curve (FIFO) | #9|
|16| Stats panel | #10|
|17| K 線 MA20/MA60/VWAP | #11|
|18| Hotkey cheat sheet | #12|
