# LighTrade (LighTrading) — 戰鬥級閃電下單與桌面交易系統

LighTrade 是一款專為高頻交易與極速下單設計的「戰鬥級閃電下單 (DOM)」交易系統。系統採用前後端分離架構，結合永豐金證券 Shioaji API，致力於提供低延遲、高可用性且視覺直覺的交易環境。

> 完整安裝 / Docker / 桌面打包 / 安全說明請見 **repo 根目錄的 [README.md](../README.md)**，此檔僅摘要本目錄結構與開發指令。

---

## 🎨 核心設計特色

1. **極速閃電下單 (DOM) 表格**
   * 經典五欄式無縫佈局：`[刪買 / 買進 / 委買量] | 價格中樞 | [委賣量 / 賣出 / 刪賣]`。
   * 內建委託量柱狀圖 (Volume Histogram) 與當前成交價亮黃高亮顯示。
   * 支援 `Space` 一鍵置中、`Esc` 緊急全刪單等鍵盤快捷操作。
   * 拖曳改價、IOC/FOK、盤中零股、期貨帳戶支援。

2. **本地智慧單引擎（含持久化）**
   * MIT 觸價 / 移動停損 / OCO / Bracket，全部落地 SQLite，backend 重啟自動 re-arm。
   * 觸發下單走風控閘門：開倉性觸發受日虧損熔斷約束、保護性停損永遠放行。

3. **高可用性防禦設計 (HA Fallback)**
   * **離線常用股票資料庫**：Shioaji 連線受限（451 等）時仍能顯示商品中文名稱。
   * **一鍵下單防連點 (Debounce)**：UI 送單後鎖定 0.5 秒，避免手震重複送單。
   * **斷線重連**：watchdog 偵測靜默斷線，重連後自動補回主商品與所有背景訂閱。

---

## 🛠️ 技術堆疊

* **前端**: React 19, TypeScript, Tailwind CSS 4, Vite, Lightweight Charts
* **後端**: Python 3.11+, FastAPI, asyncio（券商阻塞呼叫隔離在單 worker broker thread）
* **桌面外殼**: Electron（位於 repo 根目錄 `/electron`）
* **交易 API**: Shioaji API（永豐金證券，支援台股與期權）

---

## 📂 專案結構

```text
lightning_trader/
├── backend/            # FastAPI 後端路由與 API 服務
│   ├── routers/        # accounts, orders, smart, journal, risk, reports...
│   └── services/       # 廣播器 (quote, pnl)、order_guard、journal、統計
├── core/               # ShioajiClient / RiskManager / SmartOrderEngine(+SQLite store)
├── frontend/           # React 前端 SPA
│   ├── src/
│   │   ├── components/ # UI 元件 (DOMTable, Panel_Positions, ...)
│   │   └── contexts/   # TradingContext / SettingsContext / ToastContext
│   └── dist/           # 前端打包輸出目錄
└── tests/              # pytest 單元 + TestClient 整合測試（fake shioaji）
```

---

## 🚀 開發指令

```bash
# 後端（repo 根目錄放 .env，格式見 ../.env.example）
cd backend && pip install -r requirements_backend.txt
python main.py            # 127.0.0.1:8000

# 前端
cd frontend && npm install
npm run dev               # 127.0.0.1:5173

# 測試
cd .. && python -m pytest tests/ -q      # 後端
cd frontend && npx vitest run            # 前端
```

Electron 桌面版的開發與打包流程見根目錄 README「桌面應用程式」章節。

---

## 📜 授權許可

本專案供內部高頻交易與研究使用，交易風險請自行評估。
