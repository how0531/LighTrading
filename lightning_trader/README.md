# LighTrade (LighTrading) — 戰鬥級閃電下單與桌面交易系統

LighTrade 是一款專為高頻交易與極速下單設計的「戰鬥級閃電下單 (DOM)」桌面交易系統。系統採用前後端分離架構，結合了永豐金證券 Shioaji API，致力於提供低延遲、高可用性且視覺直覺的交易環境。

---

## 🎨 核心設計特色

1. **極速閃電下單 (DOM) 表格**
   * 經典五欄式無縫佈局：`[刪買 / 買進 / 委買量] | 價格中樞 | [委賣量 / 賣出 / 刪賣]`。
   * 內建委託量柱狀圖 (Volume Histogram) 與當前成交價亮黃高亮顯示。
   * 支援 `Space` 一鍵置中、`Esc` 緊急全刪單等鍵盤快捷操作。

2. **精緻的專業視覺（Navy & Gold 主題）**
   * 靈感源自大戶投 (Dawho) 的深邃海軍藍（#161C2D, #1D263B）與奢華黃金配色（#E2B25A）。
   * 數字字型全面強制等寬（Fira Code / Tabular Numbers），避免價格跳動時版面抖動。
   * 持倉部位與歷史委託採用「上方中文大、下方代碼小」的直覺排版。

3. **高可用性防禦設計 (High Availability & HA Fallback)**
   * **離線常用股票資料庫**：為防止 Shioaji API 遭遇連線限制（例如 `Too Many Connections` 451 錯誤）或網路瞬斷，後端接口整合了常用標的 fallback，保證在未成功連線時畫面仍能正常顯示商品中文名稱。
   * **一鍵下單防連點 (Debounce)**：UI 送單後鎖定 0.5 秒，避免手震重複送單。

---

## 🛠️ 技術堆疊

* **前端 (Frontend)**: React, TypeScript, Tailwind CSS, Vite, Lightweight Charts (K 線圖表)
* **後端 (Backend)**: Python, FastAPI, asyncio, PyQt5 (執行緒隔離與主事件循環)
* **桌面端外殼 (Desktop Shell)**: Electron, Node.js
* **交易 API**: Shioaji API (永豐金證券 API，支援台股與期權)

---

## 📂 專案結構

```text
lightning_trader/
├── backend/            # FastAPI 後端路由與 API 服務
│   ├── routers/        # 包含 accounts, orders, smart, journal 等路由
│   └── services/       # 包含廣播器 (quote, pnl)、統計與日誌模組
├── core/               # 交易引擎與 Shioaji API 連線核心
├── electron/           # Electron 桌面外殼啟動腳本與設定
├── frontend/           # React 前端單頁應用程式 (SPA)
│   ├── src/
│   │   ├── components/ # UI 元件 (如 DOMTable, Panel_Positions, Panel_OrderHistory)
│   │   └── contexts/   # 全域 Trading 與 Toast Contexts
│   └── dist/           # 前端打包輸出目錄
└── build.ps1           # 專案整合建置與啟動指令檔 (PowerShell)
```

---

## 🚀 快速啟動指南

系統需要同時啟動 **前端 Dev Server**、**後端 FastAPI 服務** 與 **Electron 外殼**：

### 前置需求
* Node.js v16+
* Python 3.8~3.10 (建議使用虛擬環境 `.venv`)

### 1. 後端設定與啟動
1. 在 `lightning_trader` 根目錄或 `backend` 中建立 `.env` 檔案並填入帳密憑證：
   ```env
   SHIOAJI_API_KEY=您的API金鑰
   SHIOAJI_SECRET_KEY=您的密鑰
   SHIOAJI_SIMULATION=True
   ```
2. 啟動後端伺服器 (預設運行於 `127.0.0.1:8000`)：
   ```bash
   cd backend
   ..\.venv\Scripts\python.exe main.py
   ```

### 2. 前端開發與打包
1. 安裝套件：
   ```bash
   cd frontend
   npm install
   ```
2. 啟動前端開發伺服器 (預設 `127.0.0.1:5173`)：
   ```bash
   npm run dev
   ```
3. 生產環境打包：
   ```bash
   npm run build
   ```

### 3. 啟動 Electron
1. 在 `electron` 目錄安裝 Node 依賴：
   ```bash
   cd electron
   npm install
   ```
2. 在 `lightning_trader` 根目錄啟動 Electron (開發模式)：
   ```powershell
   $env:ELECTRON_DEV="1"
   npx electron .
   ```

---

## 📜 授權許可

本專案供內部高頻交易與研究使用，交易風險請自行評估。
