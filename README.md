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

# 可選：API Token（Docker / LAN 部署強烈建議）
# 設定後所有 /api 與 WebSocket 都需要帶此 token，前端在設定視窗填同一組
LIGHTRADE_API_TOKEN=

# 可選：SIMULATION=false 時預設「不會」開機自動登入真實帳戶，
# 需明確設 true 才允許無人值守登入 LIVE
LIGHTRADE_ALLOW_LIVE_AUTOLOGIN=
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

### 桌面應用程式（Electron + 自動更新）

打包成 macOS / Windows / Linux 原生可執行檔，內含 backend、frontend、Python runtime，雙擊就能用、可背景自動更新。

#### 結構

```
Electron Main Process
  ├── spawn lightrade-backend (PyInstaller 打包 FastAPI + shioaji)
  ├── wait /api/health 200
  └── BrowserWindow → http://127.0.0.1:8000  (backend 同 origin 服務 frontend dist)
```

#### 本機開發跑 Electron

```bash
# Terminal 1：跑 backend（沿用 venv 或 docker）
cd lightning_trader/backend && python main.py

# Terminal 2：跑 frontend dev server
cd lightning_trader/frontend && npm run dev

# Terminal 3：跑 Electron（dev 模式，連到上面 backend）
cd electron
npm install
ELECTRON_DEV=1 npm run dev
```

#### 本機打包成桌面 app

```bash
# 1. Build frontend
cd lightning_trader/frontend && npm ci && npm run build

# 2. Build backend 為單檔 binary（PyInstaller --onedir）
cd ../backend
pip install -r requirements_backend.txt -r requirements_build.txt
./build_backend.sh
# → 產出 lightning_trader/backend/dist/lightrade-backend/

# 3. Build Electron 安裝包
cd ../../electron && npm ci && npm run build
# → electron/release/ 內：
#     - macOS:   LighTrade-0.1.0.dmg
#     - Windows: LighTrade Setup 0.1.0.exe
#     - Linux:   LighTrade-0.1.0.AppImage
```

#### 自動更新與發布

push 一個 git tag（例：`v0.1.0`）就會觸發 `.github/workflows/desktop-build.yml`：

```bash
git tag v0.1.0
git push origin v0.1.0
```

CI 會跨 macOS-13 (Intel) / Windows / Linux runner 各 build 一份，上傳到該 tag 對應的 GitHub Release。使用者的 Electron app 啟動時會 `electron-updater` 比對版本，有新版會跳通知。

#### 桌面版限制

| 平台 | 狀況 |
|---|---|
| Windows x64 | ✅ 主力支援 |
| Linux x64 | ✅ AppImage |
| macOS Intel | ✅ 用 `macos-13` runner build，shioaji wheel 直裝 |
| macOS Apple Silicon | ⚠️ 透過 Rosetta 跑 x86_64 binary（首次啟動慢一些；shioaji 無原生 arm64 wheel） |

桌面版仍是「單一帳號的工具」——backend 是 Shioaji 單例設計，一台機器跑一個 process，對應一組永豐金憑證。憑證從 `.env` 或登入畫面輸入，不會寫進 binary。

#### 首次開啟放行（未簽章說明）

安裝包目前**未做程式碼簽章**（Apple Developer / Windows 簽章憑證屬商業憑證採購，非開發項目）。功能完全不受影響，但首次開啟時作業系統會跳安全警告，依下列步驟放行一次即可，之後正常雙擊開啟：

**macOS（Gatekeeper）**

```
1. 雙擊 LighTrade.app → 出現「無法打開，因為無法驗證開發者」
2. 在 Finder 對 LighTrade.app 按右鍵 →「打開」→ 再按一次「打開」
   （或：系統設定 → 隱私權與安全性 → 捲到底「仍要打開」）
3. 之後即可正常雙擊開啟，不會再跳
```

若仍被擋（macOS 較新版本），可在終端機執行一次：

```bash
xattr -dr com.apple.quarantine /Applications/LighTrade.app
```

**Windows（SmartScreen）**

```
1. 執行 LighTrade Setup x.x.x.exe → 跳「Windows 已保護您的電腦」
2. 點「其他資訊」→「仍要執行」
3. 安裝完成後正常使用，不會再跳
```

**Linux（AppImage）**

```bash
chmod +x LighTrade-x.x.x.AppImage
./LighTrade-x.x.x.AppImage
```

> 這些警告只是因為安裝包沒有付費簽章憑證，**不代表程式有問題**。原始碼與建置流程皆公開於本 repo，可自行 build 驗證（見上方「本機打包成桌面 app」）。日後若採購簽章憑證，警告會自動消失，使用者無需重裝。

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
```

### 重要目錄

```
lightning_trader/
├── backend/        # FastAPI 後端
│   ├── routers/    # orders / accounts / smart / health / risk / user_settings
│   ├── services/   # pnl_broadcaster / quote_broadcaster / order_guard / contract_specs
│   └── bridge.py   # Shioaji callback → asyncio queue + on_fill 事件
├── core/           # ShioajiClient / SymbolResolver / RiskManager / SmartOrderEngine(+SQLite store)
├── frontend/       # React + Vite + Tailwind 4
│   └── src/
│       ├── contexts/  # TradingContext / SettingsContext / ToastContext
│       ├── components/DOM/  # DOMHeader / DOMTable / DOMFooter
│       └── utils/     # instrument / pnl / splitOrder
└── tests/          # pytest 單元 + TestClient 整合測試（fake shioaji）
```

---

## 安全注意

1. **API Key 永遠不送到前端**：若 `.env` 已設定，前端登入頁可不填金鑰。
2. **LIVE 模式有紅色全畫面警示**：避免 SIM/LIVE 誤操作。
3. **所有下單路徑都過 RiskManager**：`/place_order`、`/reverse`、改單、智慧單觸發皆前置檢查（部位上限 + 日虧損熔斷 + 頻率/重複防呆）。日虧損由真實資料餵入：未實現來自即時 PnL、已實現來自成交 journal 的 FIFO 重算。
4. **保護性出場永遠放行**：一鍵平倉與「平既有部位」的停損觸發不受熔斷封鎖——風控停止交易後仍能出場，只擋開新倉。
5. **WARNING 級檢查（市價單/價格偏離/反向）需二次確認**：API 回 409 `CONFIRM_REQUIRED`，前端確認後帶 `confirm: true` 重送。
6. **智慧單持久化**：停損/移停/OCO/Bracket 落地 SQLite（`~/.lightrade/smart_orders.db`），backend 重啟自動 re-arm；移停的 watermark 重啟後從當下市價重新追蹤。
7. **可選 API Token 認證**：設定 `LIGHTRADE_API_TOKEN` 後，所有 `/api`（除 health）需帶 `X-API-Token` header、WebSocket 需帶 `?token=`。**Docker / LAN 部署（backend 綁 0.0.0.0）務必設定**——CORS 只能約束瀏覽器，不是伺服器端存取控制。
8. **SIMULATION 預設 true**；且 `SIMULATION=false` 時預設不做開機自動登入，需 `LIGHTRADE_ALLOW_LIVE_AUTOLOGIN=true` 明確允許。
9. **每日 04:00 自動重置日虧損計數**：避免跨日造成假性 trading_disabled。
10. **CORS 限定本機**：可由 `LIGHTRADE_ALLOWED_ORIGINS` 環境變數擴增。

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
