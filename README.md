# LighTrade ⚡

> 為當沖極速交易而生的桌面級交易終端
> Shioaji (永豐金 API) × FastAPI × React 19 × Tailwind 4

[![CI](https://github.com/how0531/LighTrading/actions/workflows/ci.yml/badge.svg)](https://github.com/how0531/LighTrading/actions/workflows/ci.yml)

---

## 願景

1. **絕對真理同步**：所有訂單、持倉、損益毫秒級對齊券商主機，無論單從哪個平台送出。
2. **戰鬥級反應速度**：報價 / PnL / 下單回報延遲 < 300ms；DOM 操作零卡頓。
3. **3 分鐘上手**：登入後不需教學即能完成「訂閱 → 看盤 → 下單 → 平倉」。

---

## 架構

```
┌─────────────────────────┐    HTTP / WebSocket    ┌──────────────────────────┐
│  React 19 + Vite + TS   │ ────────────────────▶ │  FastAPI (uvicorn)       │
│  - DOMPanel (五檔)       │                       │  - /api/place_order …    │
│  - TradingContext (WS)  │                       │  - /ws/quotes            │
│  - ToastContext         │                       │  - pnl_broadcaster        │
└─────────────────────────┘                       │  - quote_broadcaster      │
                                                   └────────────┬─────────────┘
                                                                │
                                                                ▼
                                                   ┌──────────────────────────┐
                                                   │  core/                    │
                                                   │  - ShioajiClient (永豐)   │
                                                   │  - SymbolResolver         │
                                                   │  - RiskManager            │
                                                   │  - SmartOrderEngine       │
                                                   └────────────┬─────────────┘
                                                                │
                                                                ▼
                                                       Shioaji Cloud API
```

完整設計理念見 `design-system/lightrade/MASTER.md` 與 `lightning_trader/DOM_MASTER_PLAN.md`。

---

## 快速啟動

### 前置需求

- Python 3.11+
- Node.js 20+
- 永豐金 Shioaji API 金鑰（[申請說明](https://sinotrade.github.io/quickstart/)）

### 安裝

```bash
git clone <repo>
cd LighTrading

# 後端
cd lightning_trader/backend
pip install -r requirements_backend.txt

# 前端
cd ../frontend
npm install
```

### 設定 `.env`

在 repo 根目錄建立 `.env`：

```bash
API_KEY=YOUR_SHIOAJI_API_KEY
SECRET_KEY=YOUR_SHIOAJI_SECRET
SIMULATION=true        # 預設模擬模式；改 false 才會送真實單
CA_PATH=               # 真實交易才需要憑證
CA_PASSWD=
```

> ⚠️ `.env` 已在 `.gitignore`，**永遠不要 commit**。

### 啟動

```bash
# 一鍵起 backend + frontend
./start.sh

# 或分開跑
cd lightning_trader/backend && uvicorn main:app --port 8000
cd lightning_trader/frontend && npm run dev
```

瀏覽器開 http://localhost:5173 即可。

### Docker（推薦：一鍵啟動為網頁 app）

把專案當成個人單機網頁 app 用，最簡單的方式：

```bash
# 1. 複製範本並填入永豐金憑證
cp .env.example .env
# (編輯 .env 設定 API_KEY / SECRET_KEY)

# 2. build + 起兩個 container（首次約 3-5 分鐘）
docker compose up -d

# 3. 瀏覽器開
open http://localhost:5173   # macOS
xdg-open http://localhost:5173   # Linux
```

收工。Frontend (nginx) 跑在 5173、backend (uvicorn) 在內部網路。
所有 `/api`、`/ws` 都由 nginx 同站台轉發給 backend，前端只需要連 localhost:5173 一個 port。

**重要**：

- **架構限制 — 只能個人用**：backend 是 Shioaji 單例設計，整個 process 共用一個券商連線。多人共用一個部署會互相覆蓋帳號狀態。要給多人，需要 per-user sandbox 重構。
- **Apple Silicon (M1/M2/M3)**：shioaji 只發 x86_64 wheel，build 時加 `--platform linux/amd64`：
  ```bash
  DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose up -d --build
  ```
- **更新版本**：`docker compose pull && docker compose up -d --build`
- **看 log**：`docker compose logs -f backend`
- **停止**：`docker compose down`（不刪資料）／`docker compose down -v`（含資料）

---

## 開發

### 跑測試

```bash
# 後端 pytest（離線單元）
cd lightning_trader
python3 -m pytest tests/ -q

# 前端 TypeScript 編譯
cd frontend
npx tsc -b

# Latency 量測（需 backend 已啟動 + 登入）
python3 tests/latency_check.py --symbol TXFR1 --secs 30
```

### 重要目錄

```
lightning_trader/
├── backend/        # FastAPI 後端
│   ├── routers/    # orders / accounts / smart / health / risk / user_settings
│   ├── services/   # pnl_broadcaster / quote_broadcaster
│   └── bridge.py   # Shioaji callback → asyncio queue
├── core/           # 跨進程共用：ShioajiClient / SymbolResolver / RiskManager
├── frontend/       # React + Vite + Tailwind 4
│   └── src/
│       ├── contexts/  # TradingContext / SettingsContext / ToastContext
│       ├── components/DOM/  # DOMHeader / DOMTable / DOMFooter
│       └── utils/     # instrument / pnl / splitOrder
├── tests/          # pytest 單元測試 + latency_check 手動腳本
└── legacy/         # PyQt5 桌面版（已停止主動開發）
```

---

## 安全注意

1. **API Key 永遠不送到前端**：若 `.env` 已設定，前端登入頁可不填金鑰。
2. **LIVE 模式有紅色全畫面警示**：避免 SIM/LIVE 誤操作。
3. **RiskManager 在所有 /place_order 前置**：部位上限 + 日虧損上限 + 頻率防呆。
4. **每日 04:00 自動重置日虧損計數**：避免跨日造成假性 trading_disabled。
5. **CORS 限定本機**：可由 `LIGHTRADE_ALLOWED_ORIGINS` 環境變數擴增。

---

## 文件

| 檔案 | 內容 |
|---|---|
| `design-system/lightrade/MASTER.md` | UI 色彩 / 字體 / glassmorphism 規範 |
| `lightning_trader/DOM_MASTER_PLAN.md` | DOM 五檔功能藍圖（4 階段） |
| `lightning_trader/tests/README.md` | 測試說明 |

---

## License

Internal use only. © 2025
