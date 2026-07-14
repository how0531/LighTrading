# ADR-001：fork Shioaji Pro 前端當底座、閃電下單掛載式整併

- **Status**: Proposed
- **關聯文件**: `PLAN.md`（完整計畫）、`AGPL-FUSES.md`（授權引信）、`CAPABILITY-GAP-TEMPLATE.md`（能力落差範本）
- **授權聲明**: 本 ADR 所有授權判斷均為方向性判讀，**非正式法律意見，須法務確認**。

---

## Context

使用者要把「自己設計的閃電下單 UI ＋ 資金管理」建立在 Shioaji Pro 新系統上。使用者的實際脈絡是關鍵約束：

- **單人、盤中開著一台機器、不散布、不對外服務。**

技術事實（來自我方 codebase 測繪，未接觸 Shioaji Pro 原始碼）：

- Shioaji Pro 是**純前端、無後端** open-core：前端直連本機官方 shioaji server（HTTP + 單一 SSE），停損/停利是**客戶端觸價單，關頁即停**。它提供圖表/指標/react-grid-layout 工作區底座。授權為 **AGPL-3.0**（僅前端 repo）。
- LighTrading 是**伺服器端有狀態交易大腦**：RiskManager 熔斷、SmartOrderEngine（MIT/TRAILING/OCO/BRACKET/CHASE）tick-driven、smart_orders.db 開機 re-arm、journal.db（去重鍵 `ordno#exchange_seq`）、2.5s 對帳把外部管道成交入帳。
- 兩個決定性的可掛載事實：閃電下單子系統只透過 `useQuotes()`/`useTradingCore()` ＋ `apiClient` 取值，是靠 context 餵養的**封閉 React 子樹**；SmartOrderEngine 對 broker **完全解耦**（4 注入函數 place/cancel/confirm_cancel/tick_size ＋ EventBus）。

核心矛盾：Shioaji Pro 的觸價活在瀏覽器分頁裡，關頁即失效；使用者真正 load-bearing 的性質是「崩潰/OS 重開後自訂停損不能消失」，這需要一個**頁面外的常駐程序**。

授權關鍵：copyleft 只在**散布**或 **AGPL §13 對其他遠端使用者提供網路服務**時觸發。單機自用、不散布、localhost 只有自己＝零觸發，親手寫進 fork 的 UI 一行都不用公開（須法務確認；引信見 `AGPL-FUSES.md`）。

---

## Decision

**採用「fork Shioaji Pro 前端當底座 + 閃電下單掛載式」方向：**

1. **fork shioaji-pro-app 當 UI 底座**，沿用其圖表/指標/react-grid-layout 工作區。
2. **把閃電下單／資金管理掛成 widget**，掛進它的 grid；每顆 widget 內建一層「TradingContext 替身」黏合層對接自建後端。移除它自帶的純前端觸價停損模組。
3. **後端縮為 headless 停損 daemon**：把 SmartOrderEngine ＋ smart_order_store 抽成小常駐程序，不保留為 UI 廣播/多終端對帳而生的那大半 FastAPI。
4. **權威分工**：行情/K線唯讀，吃官方 SSE；下單/委託/成交/持倉/風控全部收斂到自建後端。UI 上「持倉」一律只認自建後端那份。

**理由**：

- 讓舊分析把 fork 判「最差」的唯一決定性理由就是授權。在「單人不散布」脈絡下該理由整個消失，fork 從「授權最差」變成「授權中性、只剩工程取捨」。
- fork 是三條路裡**唯一真正把使用者放上 Shioaji Pro 殼**的選項——這正是使用者「其餘用它的殼」的字面願景。
- 掛載式（而非移植）把工程風險侷限在 widget 邊界：可搬性有事實根據（封閉子樹 + 解耦引擎），fork 要改的很少（面板註冊表登記 widget + 移除純前端觸價）。
- headless daemon 交付了唯一 load-bearing 的性質（停損續命），又不背整棟 FastAPI 的包袱。

---

## Consequences

**正面**

- 得到 Shioaji Pro 的圖表/指標/版面/工作區底座，且在純自用下 **UI IP 損失為零**。
- 「委託雙權威」問題大幅化解：行情走官方 SSE、交易語意收斂自建後端，唯一重疊的持倉以後端為準。
- 後端瘦身成 headless daemon，維運心智負擔下降。

**負面 / 成本**

- **樣式阻抗**：vanilla-extract vs Tailwind 4 仍在，需以 prefix / scoped preflight 侷限在 widget 子樹內共存。彆扭但非死結。
- **整體 XL 級工程**：fork 一個不熟的大型前端 ＋ 樣式橋接。
- **依賴官方 shioaji server 存活**（行情），多一個失敗模式。
- **授權引信不可逆**：一旦散布/上雲共用/商業化，整包 fork（含使用者 UI）的 AGPL 義務就引爆。這是 fork 路線的固有前提，須以 `AGPL-FUSES.md` 的邊界嚴守。

**須先確認的硬 gate**

- 「這輩子只有自己用」的把握。若現在就預期散布/上雲/商業化，應改回「以自己前端為底座」以保留專有選項。
- 里程碑 0：填 `CAPABILITY-GAP-TEMPLATE.md`，確認官方 server 的 deal 唯一序號、全 session 委託/成交推送、撤單同步終態＋filled_qty。

---

## 被否決的替代方案

### 替代方案 A：純前端、無後端（照 Shioaji Pro 原形）

- **內容**：完全採用 Shioaji Pro「純前端 + 官方 server」形態，把停損/風控放前端。
- **否決理由**：關頁/崩潰/OS 重開即失去所有自訂停損——這正是使用者唯一 load-bearing 的需求無法滿足。前端熔斷可被重整繞過，無開機 re-arm，看不到外部管道成交。交付不了使用者要的安全網。

### 替代方案 B：fork 前端 + 保留整棟 FastAPI 後端

- **內容**：fork 前端當殼，但後端原封不動保留整棟 FastAPI（含 UI 廣播、多終端對帳、quote/pnl broadcaster 等）。
- **否決理由**：那大半 FastAPI 是為「UI 廣播/多終端對帳」而生，單人自用 + widget 直連下用不到；「純前端外殼旁硬掛一棟有狀態後端」的架構彆扭、部署與心智模型都變複雜。唯一 load-bearing 的停損續命只需一個 headless daemon 即可交付，整棟後端是過度投資。

### 替代方案 C：策略 3 弱耦合（概念採用 + 生態相容）

- **內容**：主體維持 LighTrading 現狀，只採 Shioaji Pro 架構概念，做唯讀 SSE 鏡像/可獨立打包等「宣稱相容」手勢。
- **否決理由**：其產出（宣稱生態相容、唯讀 SSE 鏡像、可獨立打包）全是產品定位/第三方消費者需求，單人自用一個都用不到。它「沒有真的搬到 Shioaji Pro 上，只是宣稱相容」——恰好給不了使用者要的「殼」。可保留其中**契約凍結**部分（收斂 13 種 WS type、凍結 4 函數注入契約）當可維護性加值，但不作為主線。

### 替代方案 D（降級為 deferred option，非否決）：換官方 shioaji server 通道

- **內容**：保留自建後端當交易大腦，只把 `shioaji_client` 傳輸面從 in-process SDK 換成官方 shioaji server（HTTP+SSE）。
- **狀態**：對使用者是**純成本**——只有在 in-process SDK 實際造成維運痛點（版本相容、threading 脆弱、想要 server 隔離、想留 Tauri sidecar 選項）時才值得。SDK 現在能跑就先別動。列為未來選項，不進本次主線。
