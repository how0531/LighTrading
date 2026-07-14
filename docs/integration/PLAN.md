# LighTrading × Shioaji Pro 整併計畫（最終版）

> 決策級落地文件。記錄「以 fork Shioaji Pro 前端當底座、把自建閃電下單／資金管理掛成 widget、後端縮為 headless 停損 daemon」這個已拍板方向的完整計畫。
>
> **所有授權判斷均為方向性判讀，非正式法律意見，須法務確認後方可視為結案。** 詳見 `AGPL-FUSES.md`。
>
> 相關文件：`ADR-001-shioajipro-mount.md`（決策紀錄）、`AGPL-FUSES.md`（授權引信與自用邊界）、`CAPABILITY-GAP-TEMPLATE.md`（官方 server 能力落差表範本）。

---

## 0. 一句話結論

在使用者「單人、盤中開著一台機器、不散布、不對外服務」的實際脈絡下，**fork Shioaji Pro 前端當底座、把自建閃電下單掛成它工作區裡的 widget、後端縮為一個 headless 停損 daemon** 是使用者字面願景的唯一交付路徑，而純自用讓它的 UI IP 損失為零。

這推翻了「fork＝UI 被迫開源＝最差」的舊結論——那個結論建立在「散布情境」的授權框架上，對一個從不散布的單人工具並不成立。

---

## 1. 兩邊架構對照表

| 維度 | LighTrading（現況，專有） | Shioaji Pro（公開事實） |
|---|---|---|
| **後端** | 有，且是重點：FastAPI + core Python，行程內直接用 Shioaji Python SDK；三條單-worker executor（broker / order / sync） | **無任何後端程式碼**（純前端 open-core） |
| **資料通道** | 前端 ↔ 我方後端：單一 WS `/ws/quotes`（13 種自訂訊息、callback/snapshot 雙序號防亂序）＋ REST `/api/*`（含 /place_order、/flatten、/reverse、/smart_orders 等聚合端點） | 前端**直接**連本機官方 CLI「shioaji server」：HTTP API ＋ 單一 SSE 串流（tick/五檔/回報），預設 127.0.0.1:8080 |
| **觸價 / 智慧單落點** | **伺服器端**：SmartOrderEngine（MIT/TRAILING/OCO/BRACKET/CHASE）tick-driven 跑在後端行情執行緒；cancel-replace 靠 `confirm_order_cancelled` 維持不變量 | **客戶端**：停損/停利是「客戶端觸價單」，**只在頁面開啟時監控，關頁即停**（README 明講） |
| **資金管理 / 風控落點** | **伺服器端唯一權威**：RiskManager（日虧損熔斷/reduce-only 豁免/頻率）、order_guard FIFO 已實現損益、pnl_broadcaster 未實現餵入 | 客戶端；AI Agent / 策略回測為**閉源專屬二進位模組**（原始碼不在 repo） |
| **持久化** | `~/.lightrade/`：`journal.db`（成交 fills，去重鍵 `ordno#exchange_seq`，已實現損益資料源）、`smart_orders.db`（智慧單開機 re-arm；trailing watermark 刻意不落地）；RiskConfig/熔斷 latch 目前不落地 | 前端 localStorage 等級；無伺服器持久化 |
| **授權** | 專有（Internal use only） | **shioaji-pro-app 前端 repo 為 AGPL-3.0**；商業閉源需向永豐（SinoPac）洽 dual licensing。底層 shioaji SDK / shioaji server 工具**非** AGPL（各自授權，**須法務確認**） |
| **UI 技術棧** | React 19 + Vite + **Tailwind 4** + lightweight-charts v5；TradingContext 拆 Quotes/Core 雙 context | React 19 + TS + Vite + **vanilla-extract** + lightweight-charts v5 + react-grid-layout v2 |

---

## 2. 核心矛盾（必須正視）

**Shioaji Pro 是「純前端、無後端」，它的觸價與資金管理都活在瀏覽器分頁裡，關頁即失效。**
**LighTrading 真正 load-bearing 的性質，恰恰是「伺服器端持久化的智慧單與風控」——斷線、重啟、關頁都持續運作。**

具體撞擊點：

1. **關頁即失 vs 關頁續跑**：Shioaji Pro 的停損隨分頁關閉消失。我方觸價判斷跑在後端行情執行緒，不依賴瀏覽器存活。分頁崩潰/OOM/OS 重開時，頁內觸價確實無解——這不是嚇唬，是真實技術性質。
2. **無重啟復原 vs 開機 re-arm**：Shioaji Pro 沒有 broker session 層的持久化。我方 `smart_orders.db` 落地 ＋ `_restore_from_store` 開機自動復掛保護單。
3. **只看本 session vs 外部管道入帳**：Shioaji Pro 看不到本 session 以外的成交。我方 2.5s 對帳迴圈把「券商 App / 其他 session」的成交拉回，餵熔斷與 CHASE 對帳。
4. **前端自律 vs 伺服器強制風控**：純前端的熔斷可被「重整頁面」繞過。我方 `pre_order_check` 是所有下單路徑之前的 fail-closed 授權門。

**這條矛盾的化解方式不是「放棄後端」，而是「權威分工」**：把不能死的那條（停損續命）留在一個頁面外的常駐程序，其餘沿用 Shioaji Pro 的殼。詳見第 5 節。

> 注意：這裡真正 load-bearing 的只有一條——**崩潰/OS 重開後，自訂停損不能消失**。這需要「頁面外的常駐程序」，但**不需要整棟 FastAPI**。個人工具沒有「護城河」，只有「給自己的安全網」。

---

## 3. 授權分岔（為何舊結論被推翻）

著作權附著在「表達（原始碼）」，不附著在「概念/架構點子」。是否 fork / 衍生 Shioaji Pro 的 AGPL 前端，是整份計畫的授權分岔點。

- **舊框架（把使用者當專有產品公司）**：fork AGPL 前端＝必然 AGPL＝UI IP 外流＝最差選項。
- **實際脈絡（單人、不散布、不對外服務）**：copyleft **只在散布或 §13 對其他遠端使用者提供網路服務時觸發**。單機自用、不散布、localhost 只有自己＝零觸發。親手寫進 fork 的閃電下單 UI，**一行都不用公開**。

法理（GPLv3 §2 / AGPL §13，須法務確認）：授權書本來就授予「製作衍生作品與私下使用」的權利；copyleft 是「散布／對外網路服務」的附帶條件，不是「修改」或「使用」的條件。AGPL §13 針對的是「透過網路遠端與之互動的**其他**使用者」——localhost 上唯一的使用者是自己。

因此「fork＝授權最差」對使用者不成立；那個唯一決定性的否決理由消失後，fork 從「授權最差」變成「授權中性、只剩工程取捨」的選項——而它是三條路裡**唯一真正把使用者放上 Shioaji Pro 殼**的選項。

> **關鍵前提（唯一的硬 gate）**：這條路乾淨的前提是「這輩子只有自己用」。一旦決定散布/上雲共用/商業化，fork 的 IP 會在那一刻整包引爆（含使用者自己的 UI）。六根引信與自用邊界見 `AGPL-FUSES.md`。

---

## 4. 選定方向：fork 掛載式

**採用方向 = fork Shioaji Pro 前端當底座，把自建的閃電下單＋資金管理掛成它 grid 工作區裡的自帶後端 widget。**

這就是「閃電下單變我的設計、其餘用它的殼」的字面願景，而個人自用讓它 IP 損失為 0。被否決的替代方案（純前端無後端、fork 但整棟後端、策略 3 弱耦合）及否決理由，見 `ADR-001-shioajipro-mount.md`。

### 4.1 後端縮為 headless 停損 daemon

無論走哪條路，都值得把 `SmartOrderEngine` ＋ `smart_order_store` 抽成一個 **headless 小 daemon**——架構已為它解耦好（見 4.2 權威分工）。不需要為「UI 廣播/多終端對帳」而生的那大半 FastAPI。

daemon 的存在動機講清楚：**「我的停損不該因為關分頁就消失」，不是「護城河」。**

進一步減法（值得優先向永豐確認）：問永豐是否支援**券商端條件單/停損**。

- 若支援 → 「固定價停損」這塊需求可整個外包給券商，連 daemon 都能省。
- 只有 TRAILING / CHASE / OCO / BRACKET 這些券商掛不住的型別，才非要本機引擎不可。

### 4.2 掛載式工程形態（掛載，不是移植）

- **widget**：閃電下單／資金管理＝幾顆自成一體的 widget，掛進 Shioaji Pro 的 react-grid-layout 工作區，坐在它的圖表/指標面板旁邊。可搬性有事實根據——閃電子系統只透過 `useQuotes()`/`useTradingCore()` ＋ `apiClient` 取值，是靠 context 餵養的封閉 React 子樹；SmartOrderEngine 對 broker 完全解耦（4 注入函數＋EventBus）。
- **TradingContext 替身**：每顆 widget 內部自帶一層「TradingContext 替身」資料黏合層，對接自建後端（下單/風控/智慧單/委託對帳）。
- **權威分工（乾淨）**：
  - **行情/K線＝唯讀**：讓 Shioaji Pro 面板繼續吃**官方 SSE**。
  - **下單/委託/成交/持倉/風控＝全部收斂到自建後端**（order_sync 已在做對帳）。
  - 這樣「委託雙權威」問題大幅化解——唯一真正重疊的「持倉」，UI 上一律只認自建後端那份。
- **fork 要改的很少**：在它的面板註冊表登記自製 widget ＋移除它自帶的純前端觸價停損模組，而非逆向整個資料層。

### 4.3 殘留成本（誠實講）

- **樣式阻抗**：vanilla-extract（Shioaji Pro）vs Tailwind 4（我方）仍在。掛載式 widget 邊界讓它可控——Tailwind 用 prefix / scoped preflight 侷限在自己的子樹內共存。這是彆扭，不是死結。
- **整體工程量**：仍是 XL 級（fork 一個不熟的大型前端＋樣式橋接），但**沒有任何 IP 損失**。

---

## 5. Roadmap（用階段/里程碑，不用日期）

### 里程碑 0 — 能力落差盤點（就做這個，一個下午）

啟動官方 shioaji server，開 `/docs` 讀 OpenAPI，配合 Shioaji tutor 的 order/deal event 文件，填 `CAPABILITY-GAP-TEMPLATE.md`。**全程只碰官方 server 工具，零 AGPL 曝險。** 三件必確認的事：

1. deal event 是否帶穩定唯一序號（對應 journal 去重鍵 `ordno#exchange_seq`）→ 決定去重是否失效。
2. 是否推「所有 session」的委託/成交 → 決定 order_sync 能否簡化。
3. 撤單是否有同步終態確認＋filled_qty → 決定 CHASE 不變量能否維持。

這一步同時服務掛載式 fork（widget 後端仍要對接官方 server 取行情）。

### 里程碑 1 — fork 起手與定位

fork shioaji-pro-app，本機跑起來，定位它的**面板/widget 註冊機制**與**純前端觸價模組**。

### 里程碑 2 — 最小 widget 打通

先做一顆最小 widget：把 DOMPanel 子樹＋一個 TradingContext 替身塞進它的 grid，跑通「點價下單 → 自建後端 → 回報對帳 → ladder 徽章」。

### 里程碑 3 — 移除純前端觸價、接上 headless daemon

移除 Shioaji Pro 的純前端觸價，接上自建後端的 SmartOrderEngine（智慧單/CHASE 面板走 `/smart_orders` ＋ SmartOrderUpdate WS）。

### 里程碑 4 — 護城河回歸測試

驗證崩潰/重開後停損仍續命（由後端 daemon 負責，與 fork 前端無關）。

### 里程碑 5 — 資金管理 widget 與樣式橋接

把日虧損/PnLUpdate/RiskStatusUpdate 消費端植入其版面；把 Tailwind 子樹以 prefix / scoped preflight 與 vanilla-extract 共存。

---

## 6. 需要拍板的問題（3 個真正關鍵的）

1. **「只有自己用」的把握有多高？**（唯一決定 fork 是否安全的 gate）
   - 高／可接受未來要散布再談永豐授權 → **fork 掛載式成立**，UI IP 現在零損失。
   - 現在就要給人/上雲/賣 → 別 fork，走以自己前端為底座的路線，保留專有選項。
2. **真正想要的，是 Shioaji Pro 的「殼」（圖表/指標/react-grid-layout 工作區），還是只想「行情走官方資料源」？**
   - 想要殼 → fork 掛載式。
   - 只想要官方資料源、殼用自己的 → 換官方 shioaji server 通道，且僅在 in-process SDK 有維運痛點時才值得。
3. **停損需求裡，「固定價停損」佔多少、「TRAILING/CHASE/OCO/BRACKET」佔多少？**
   - 若多為固定價，且永豐支援券商端條件單 → 大幅外包給券商，本機常駐程序可極小化甚至免除。
   - 若重度依賴自訂型別 → 保留 headless 停損 daemon（不必是整棟 FastAPI）。

---

**底線**：fork Shioaji Pro 前端當底座、把閃電下單掛成它工作區裡的 widget，是使用者字面願景的唯一交付路徑，且個人自用讓它 IP 損失為零。後端不必是整棟 FastAPI，只需一個 headless 停損 daemon（架構已解耦），動機是「我的停損不該因為關分頁就消失」。SSE schema 不是法務門檻，是一個下午的官方文件閱讀。以上法律判斷均須法務確認，但方向明確。
