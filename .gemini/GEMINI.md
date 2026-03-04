# Gemini Sub-agent Delegation Rules

## Context

你是透過 `gemini` CLI 呼叫的子代理，協助開發 **LighTrade** — 一套即時交易看盤下單系統。

### 技術架構

```
LighTrading/
└── lightning_trader/
    ├── core/                  # 核心業務邏輯 (Python, PyQt5)
    │   ├── __init__.py        # TradingEngine 工廠
    │   ├── shioaji_client.py  # Shioaji API 封裝 ★
    │   ├── event_bus.py       # 事件匯流排 (pyqtSignal)
    │   ├── order_manager.py   # 訂單管理
    │   ├── position_tracker.py # 部位追蹤
    │   ├── smart_order_engine.py # 智慧委託
    │   ├── risk_manager.py    # 風控引擎
    │   └── config.py          # 環境設定
    │
    ├── backend/               # FastAPI 後端
    │   └── main.py            # REST API + WebSocket ★
    │
    ├── frontend/              # React 前端
    │   └── src/
    │       ├── contexts/TradingContext.tsx  # WebSocket + 報價狀態 ★
    │       ├── components/DOMPanel.tsx      # DOM 五檔面板 ★
    │       ├── components/Header.tsx        # 頂部導覽列 (LOAD 按鈕)
    │       ├── types.ts                     # TypeScript 型別定義
    │       └── api/client.ts               # axios 設定
    │
    └── ui/                    # PyQt5 桌面版 UI (選用)
```

### 即時報價資料流（v1 回呼，V1.0.4）

```
Shioaji API
  ↓ set_on_tick_stk_v1_callback / set_on_bidask_stk_v1_callback
  ↓ set_on_tick_fop_v1_callback / set_on_bidask_fop_v1_callback
shioaji_client._on_tick_stk()       # v1 物件 → 統一 dict + Price=0 過濾
  ↓ _direct_quote_callback
backend/main.py on_shioaji_quote()  # 格式化 Tick/BidAsk (靜態欄位只送非零值)
  ↓ call_soon_threadsafe
asyncio Queue (quotes_to_broadcast)
  ↓ quote_broadcaster()
WebSocket /ws/quotes
  ↓ onmessage
TradingContext.tsx mergeQuote()      # 防禦性合併 + quoteDirtyRef + 100ms 節流
  ↓ setQuote
DOMPanel.tsx                        # React 渲染
```

### 帳戶/訂單更新（低頻，走 Qt Signal）

```
shioaji_client
  ↓ pyqtSignal (signal_account_update / signal_order_update)
backend/main.py on_shioaji_account_update()
  ↓ asyncio Queue → WebSocket
TradingContext.tsx
```

---

## Core Directives

### 1. UI/UX 設計規範

前端**必須**遵循 "Dawho" 專業金融風格（詳見 `design-system/lightrade/MASTER.md`）：

| 角色       | 色碼      | Tailwind Token |
| ---------- | --------- | -------------- |
| 最深背景   | `#101623` | `slate-950`    |
| 面板背景   | `#1C2331` | `slate-900`    |
| Hover 狀態 | `#29344A` | `slate-800`    |
| 邊框       | `#3E4E6D` | `slate-700`    |
| 強調/買入  | `#EF4444` | `buy-muted`    |
| 賣出/下跌  | `#10B981` | `sell-muted`   |
| 金色高亮   | `#D4AF37` | `accent-amber` |

> ⚠️ 台灣慣例：**紅色 = 買入/上漲、綠色 = 賣出/下跌**（與歐美相反）

- **字體**：`Barlow` 用於數字、`Fira Code` / `Fira Sans` 用於 UI 文字
- **數字表格對齊**：所有高頻更新的數字必須使用 `font-variant-numeric: tabular-nums`
- **Glassmorphism**：面板使用 `.glass-panel` 類別（定義於 `index.css`）

### 2. 執行緒安全 (Thread Safety)

> **嚴禁**在 FastAPI route handler 中直接呼叫 `ShioajiClient` 的方法！

- `ShioajiClient` 繼承 `QObject`，綁定 Qt 主執行緒
- FastAPI 跑在 uvicorn 的 ASGI 執行緒池
- 跨執行緒呼叫會導致 `QObject::startTimer` 崩潰

**正確做法**：使用 `run_in_qt_thread()` 包裝（定義於 `backend/main.py`）

```python
# ❌ 錯誤
@app.get("/api/positions")
async def get_positions():
    return shioaji_client.list_positions()  # 直接呼叫，會崩潰!

# ✅ 正確
@app.get("/api/positions")
async def get_positions():
    return await run_in_qt_thread(shioaji_client.list_positions)
```

### 3. 報價串流規則

- **必須使用 v1 回呼**：`set_on_tick_stk_v1_callback` / `set_on_bidask_stk_v1_callback` / `set_on_tick_fop_v1_callback` / `set_on_bidask_fop_v1_callback`
- **不要使用** `set_quote_callback`（舊版 dict 格式，Shioaji 新版不觸發）
- **不要用** Qt Signal emit 傳遞報價（uvicorn 環境下不可靠）
- **login 後必須** 重新呼叫 `_setup_callbacks()` 確保 v1 回呼在已登入狀態下生效
- **Price=0 的 Tick** 必須在後端過濾，不傳給前端
- **靜態欄位**（Reference, LimitUp, LimitDown）只在非零時才送，避免覆蓋 Snapshot
- **前端節流**：使用 `quoteDirtyRef` dirty flag + 100ms 計時器，**不要** 將 `latestQuoteRef` 設為 `null`

### 4. 訂單邏輯

- 參考 `trading_algo_patterns/SKILL.md` 的進階委託模式
- 所有下單邏輯必須區分 **模擬模式** vs **正式模式**
- API 認證資訊存放在 `backend/.env`，絕不 hardcode

### 5. 前端開發規則

- React 18 StrictMode 下 WebSocket 會雙重掛載
  - 使用 `useRef` 函式 + `setTimeout` 延遲連線
  - `useEffect` 的依賴必須是 `[]`（空陣列）
- 高頻報價更新使用 **ref 緩衝區 + 100ms 節流計時器**，避免 setState 壓垮 React
- `subscribe()` 必須在 WebSocket 未連線時也能運作（自動觸發重連）

### 6. 輸出語言

- 所有輸出請使用**繁體中文**
- Commit message 使用繁體中文
- 程式碼註解使用繁體中文

### 7. 關鍵檔案速查

| 需求             | 檔案                                                           |
| ---------------- | -------------------------------------------------------------- |
| 串流回呼邏輯     | `core/shioaji_client.py` → `_setup_callbacks`                  |
| API 路由         | `backend/main.py`                                              |
| WebSocket 連線   | `frontend/src/contexts/TradingContext.tsx`                     |
| DOM 五檔面板     | `frontend/src/components/DOMPanel.tsx`                         |
| 色碼/字體定義    | `frontend/src/index.css` + `design-system/lightrade/MASTER.md` |
| TypeScript 型別  | `frontend/src/types.ts`                                        |
| 交易引擎工廠     | `core/__init__.py` → `TradingEngine`                           |
| Shioaji API 文件 | `.agents/skills/shioaji/SKILL.md`                              |
| 進階委託模式     | `.agents/skills/trading_algo_patterns/SKILL.md`                |
