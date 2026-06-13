# Sprint 34 — 看盤環境 Market Watch

> 動機：使用者反饋專案欠缺看盤環境。參考 Sinotrade/shioaji-pro-app 的功能設計
> （多週期圖表、報價看板、自訂工作區），**但該專案為 AGPL-3.0，不引入任何其程式碼**，
> 全部以本專案既有技術棧（React 19 + lightweight-charts + react-grid-layout）原生重實作。
>
> 根因：commit afed278 將 Dashboard 由 11 面板縮為 3 面板（dom/pos/hist），
> chart/watch/equity/stats/bal/smart/journal/trade 自主畫面消失，
> 而 layoutPresets.ts 仍引用 11 個 key，preset 半失效。

## 工作包

### A — 多圖看盤（agent A）
- `ChartPanel.tsx` 重構：支援 `symbol?` / `compact?` props，無 props 行為不變（跟隨 targetSymbol）
- 新增 `MultiChartPanel.tsx`：1/2/4 宮格，每格獨立 symbol + timeframe
- 非主商品即時更新：吃 `watchlistQuotes` MiniQuote（close-only update）

### B — 報價看板（agent B）
- `TradingContext.tsx`：MiniQuote 擴充 `volume`（累計）、可得時補 bid/ask
- 新增 `QuoteBoardPanel.tsx`：報價矩陣（成交/漲跌/漲跌%/高低/總量），可排序，
  點列 → setTargetSymbol + subscribe，stale 列變灰

### C — 指標擴充（agent C）
- `utils/indicators.ts`：`computeEMA(bars, period)`、`computeBollinger(bars, period=20, mult=2)`
- `utils/indicators.test.ts`：對應 vitest

### D — 整合（agent D，依賴 A/B/C）
- Dashboard 恢復 11 面板 + 掛 `quotes`（QuoteBoard）、`mchart`（MultiChart）→ 13 面板
- 面板顯示開關（preset / 使用者可隱藏面板，保留 afed278「主畫面精簡」意圖）
- `layoutPresets.ts` 新增「看盤」preset（報價看板 + 多圖為主、DOM 側欄）
- `PanelWindow.tsx` 補新面板 popout 路由

### QA（orchestrator）
- `npx tsc -b`、`vitest run`、後端 pytest
- BACKLOG.md / README.md 對帳更新

## 授權紅線

shioaji-pro-app（AGPL-3.0）僅作功能參考，禁止複製其原始碼、樣式檔或資源。
