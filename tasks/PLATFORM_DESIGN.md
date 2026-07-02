# LighTrade 平台設計藍圖 — 以交易者便利性為核心

> 目標：從「一堆功能面板」進化為**功能完整、好懂、操作多樣**的當沖／波段交易平台。
> 設計主軸：圍繞交易者的實際工作流（選股 → 下單 → 管部位 → 控風險 → 覆盤 → 精進），
> 每個環節都要「新手看得懂、老手用得快」。

---

## 一、現況全景（每個運作細節）

### 資料流
```
Shioaji API ──(callback thread)──> core/shioaji_client ──> EventBus / signal_*
                                          │
                              backend/bridge ──> asyncio queue
                                          │
   FastAPI routers/services ──> WebSocket /ws/quotes ──(全廣播)──> 所有前端連線
                                          │
        前端 TradingContext（100ms throttle flush）──> React state ──> 15 個面板
```

### 現有能力盤點
| 環節 | 已有 | 檔案 |
|---|---|---|
| 看盤 | DOM 階梯、K線(MA/EMA/BB/VWAP/RSI)、報價看板、多圖、逐筆(內外盤)、盤勢排行、自選 | DOMPanel / ChartPanel / QuoteBoardPanel / MultiChartPanel / TimeSalesPanel / MoversPanel / WatchlistPanel |
| 下單 | DOM 點擊閃電下單、快捷鍵、智慧單(觸價/移動停損/OCO/Bracket) | DOMTable / hotkey / SmartOrdersPanel / core.smart_order_engine |
| 管部位 | 即時持倉損益、委託歷史、成交歷史、一鍵平倉/反手 | Panel_Positions / Panel_OrderHistory / Panel_TradeHistory |
| 風控 | 日虧損上限→停止交易 banner、本地價格穿越警報 | core.risk_manager / usePriceAlerts |
| 覆盤 | 交易日誌(標籤/備註)、權益曲線、績效統計、日報 | JournalPanel / EquityCurvePanel / StatsPanel / reports |
| 版面 | 4 預設(動能/當沖/波段/看盤)、可拖曳網格、Electron 彈出視窗 | layoutPresets / Dashboard / PanelWindow |
| 通知 | Telegram/Discord webhook、成交系統通知 | alert_dispatcher / useFillNotification |

### 現況痛點（阻礙「好懂 + 多樣 + 完整」）
1. **好懂**：無新手引導；預設 focus mode 一開啟就把大部分面板藏起來；面板資訊密度高、術語（內外盤/VWAP）無說明；設定視窗 978 行難導覽。
2. **多樣**：下單只有 DOM 點擊 + 快捷鍵兩種入口，缺「傳統下單票」與「圖表下單（在 K 線上拖拉停損停利）」；K 線無畫線工具；智慧單只能從清單設定、不能從圖上拉。
3. **完整**：無模擬／回放練習模式；風控只有單一日虧損上限，缺部位級風險、保證金/曝險視圖；警報只有價格穿越、缺指標/量能警報；選擇權未浮現（Shioaji 支援）。
4. **架構**：事件層（OrderManager/PositionTracker）被實例化卻空轉、成交事件鏈未接通 → 覆盤/風控的資料源不穩；`run_in_qt_thread` 阻塞事件迴圈 → 下單時報價卡頓；領域常數（乘數/正規化/委託狀態）多份散落；TradingContext/SettingsModal/shioaji_client 為 god-file。

---

## 二、設計三支柱

### 支柱 A — 好懂（降低認知負擔）
- **雙模式**：`新手 / 專業`切換。新手模式＝精簡面板 + 名詞提示 + 引導；專業模式＝現有高密度。
- **首次啟動導引**：登入後三步導覽（選商品 → 下單 → 看部位），可跳過。
- **一致的設計系統**：延續已抽的 `PanelTitle` / `priceColor`，補 `PanelShell` / `StatTile` / 按鈕 / 色彩 token，讓每個面板長得一致、好認。
- **情境化說明**：術語旁 `?` tooltip、風控狀態用白話解釋（已有雛形）。

### 支柱 B — 操作多樣（同一個意圖、多種入口）
核心手法：抽一層**下單意圖（Order Intent）**，讓所有入口共用同一條驗證＋送單路徑：
```
DOM 點擊 ─┐
快捷鍵 ───┤
下單票 ───┼──> useOrderIntent(intent) ──> 風控預檢 ──> POST /place_order
圖表下單 ─┤
警報觸發 ─┘
```
- 新增**傳統下單票**（限價/市價/停損、數量預設、Bracket 一鍵）。
- 新增**圖表下單**：在 K 線上直接下單、拖曳停損/停利線（智慧單視覺化）。
- 快捷鍵可自訂（已有 hotkey_manager 基礎）。

### 支柱 C — 功能完整（覆蓋交易全生命週期）
- **模擬/回放**：練習模式（用歷史 K 線回放 + 模擬下單），降低新手門檻。
- **風險儀表板**：部位曝險、保證金使用率、單筆/當日風險、集中度。
- **進階警報**：指標穿越（均線/RSI）、量能異常、大單，並可「警報 → 自動下單」。
- **選擇權**：浮現 Shioaji 選擇權鏈（後續）。

---

## 三、交易者工作流重構（功能藍圖）

> 以交易者的一天為主線，每個環節列「要補的體驗」。

1. **選股看盤**：盤勢排行點擊直接進主圖（已有）；自選分組/多分頁；熱力圖；報價看板加警報鈴。
2. **決策下單**：下單票 + 圖表下單 + 一鍵 Bracket；下單前顯示預估保證金/風險。
3. **部位管理**：部位卡片化（含即時損益條、距停損距離）；一鍵移動停損到成本；部位級快捷平倉。
4. **風險控管**：風險儀表板；接近上限主動預警（不只事後 banner）；每商品口數上限。
5. **交易覆盤**：日誌自動帶入進出場截圖/K 線標記；標籤化績效歸因（已有 stats 基礎）。
6. **精進學習**：回放練習模式；策略假設 → 覆盤驗證的閉環。

---

## 四、架構優化（支撐上述體驗的技術基礎）

| # | 初步 | 為何（對交易者的價值） | 風險 |
|---|---|---|---|
| A1 | **領域層 domain/**：集中 symbol 正規化 / 乘數 / 委託狀態 / 下單列舉，前後端共用單一真相源 | 損益/狀態不再因多份定義漂移 | 低（已起頭 contract_specs） |
| A2 | **接通成交事件鏈**：emit `signal_trade_update`、串起 journal/PnL/alert | 覆盤/風控資料才即時可信 | 高（需 SDK 驗證） |
| A3 | **`run_in_qt_thread` 非阻塞化**（單執行緒 executor） | 下單時報價不卡頓 | 高（需 SDK） |
| A4 | **型別安全 WS 協定**（discriminated union） | 減少 `any`、防前後端漂移 | 中 |
| A5 | **前端 Order Intent 層** `useOrderIntent` | 一次實作、多入口共用（下單票/圖表下單） | 中 |
| A6 | **拆 god-file**：TradingContext→hooks、SettingsModal→分頁、shioaji_client→gateway | 好維護、加功能快 | 中～高 |
| A7 | **UI kit**：PanelShell/StatTile/色彩 token（延續 PanelTitle/priceColor） | 面板一致、好懂、開發快 | 低 |

---

## 五、分階段路線圖

### Phase 1 — 地基與一致性（低風險、可自動驗證，先做）
- A7 UI kit（PanelShell/StatTile/色彩 token 收斂剩餘 20 檔）
- A1 領域層 domain/（把乘數/狀態/正規化收斂，含前端 getMultiplier）
- A4 WS 型別（discriminated union，順帶降 `any`）
- 好懂：術語 tooltip、風控白話化

### Phase 2 — 下單多樣性（交易者最有感）
- A5 Order Intent 層
- 傳統下單票面板
- 圖表下單（K 線上下單 + 拖曳停損停利）
- 每商品口數上限 + 下單前風險預估

### Phase 3 — 完整度（風控 + 覆盤 + 學習）
- 風險儀表板
- 進階警報（指標/量能 → 可接自動下單）
- 覆盤增強（K 線標記進出場）
- 回放/模擬練習模式

### Phase 4 — 深水區（需 SDK 環境、較大重構）
- A2 成交事件鏈接通、A3 非阻塞化、A6 god-file 拆分、選擇權鏈

> 治理：延續「各部位 agent 提案 → PM 裁決 → 實作」的流程，每個 Phase 先提案再動工。
> 每次改動守住既有自動化（後端 pytest、前端 tsc/vitest/eslint/build），碰真實券商的高風險項延後到有 SDK 環境。
