# LighTrade Design System — MASTER

> **規則優先級：** 如果 `design-system/pages/[page-name].md` 存在，該檔案的規則覆蓋本文件。

### 核心交易開發原則 (Core Trading Directives)（強制）
1. **後端絕對真理 (Strict Backend Truth)**：所有訂單狀態、資金餘額、持倉數量，**必須且只能**由後端 API 或 WebSocket 推送更新。前端禁止實作 Optimistic UI（樂觀預期）去提前扣款或增加持倉，避免在極端行情下產生假資料。下單 API 回傳 200 僅代表「請求送出」，實際狀態必須等 WebSocket 訂單回報。
2. **雙重防護同步 (Dual-Guard Synchronization)**：報價流走高頻 WebSocket，但訂單與持倉狀態必須實作「主動查詢 (Polling) + 被動接收 (WebSocket)」雙重機制。當 WebSocket 斷線重連後，必須第一時間主動呼叫 API 同步最新帳務狀態，絕不允許出現「漏接一筆回報導致部位算錯」的致命錯誤。
3. **視覺降噪與聚焦 (Visual Action & Context)**：不要把所有能拿到的資料都塞進畫面。交易員在看盤時視野極度限縮，介面設計必須引導視覺焦點。高頻閃爍的數字只能是當前關注商品的報價；非當前商品的跳動必須降級（例如淡化顏色或只顯示箭頭）。錯誤訊息必須具備「可操作性（Actionable）」，不要只彈出「代碼 500」，要告訴交易員「保證金不足，目前缺額 XXX 元」。

---

**專案名稱：** LighTrade  
**版本：** V1.0.12  
**目標：** 開發一套「為當沖極速交易而生」的桌面級金融看盤下單軟體。交易終端 (Dawho × Bloomberg Terminal)  
**CSS 實作檔：** `frontend/src/index.css`

---

## 色彩系統

### 背景層級

| 角色       | Hex       | Tailwind Token | CSS 變數            | 用途                 |
| ---------- | --------- | -------------- | ------------------- | -------------------- |
| 最深背景   | `#101623` | `slate-950`    | `--color-slate-950` | `<body>`, 主畫面背景 |
| 面板背景   | `#1C2331` | `slate-900`    | `--color-slate-900` | 所有 `.glass-panel`  |
| Hover 狀態 | `#29344A` | `slate-800`    | `--color-slate-800` | 按鈕/列表 hover      |
| 邊框       | `#3E4E6D` | `slate-700`    | `--color-slate-700` | 面板邊框, 分隔線     |

### 語義色彩

| 角色            | Hex       | Token          | 說明                              |
| --------------- | --------- | -------------- | --------------------------------- |
| **買入 / 上漲** | `#EF4444` | `buy-muted`    | ⚠️ 台灣慣例：紅色 = 漲            |
| **賣出 / 下跌** | `#10B981` | `sell-muted`   | ⚠️ 台灣慣例：綠色 = 跌            |
| **金色高亮**    | `#D4AF37` | `accent-amber` | 當前價、CTA 按鈕、LOAD 按鈕 hover |
| **文字主色**    | `#F1F5F9` | —              | 一般文字                          |
| **文字次要**    | `#94A3B8` | `slate-400`    | 標籤、說明文字                    |

### 光暈效果

```css
.text-glow-green {
  text-shadow: 0 0 10px rgba(71, 240, 184, 0.5);
} /* 上漲閃爍 */
.text-glow-red {
  text-shadow: 0 0 10px rgba(203, 30, 30, 0.5);
} /* 下跌閃爍 */
```

---

## 字體系統

| 字體          | 用途                          | 權重    |
| ------------- | ----------------------------- | ------- |
| **Barlow**    | 所有數字顯示（報價、量、PnL） | 400–800 |
| **Fira Code** | 程式碼風格文字、標題          | 400–700 |
| **Fira Sans** | UI 文字、按鈕、標籤           | 300–700 |

**Google Fonts Import：**

```css
@import url("https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700;800&family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap");
```

### 數字對齊（必須）

所有高頻更新的報價數字**必須使用**：

```css
.tabular-nums {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}
```

> 不使用 tabular-nums 的報價數字會在更新時左右跳動，嚴重影響交易體驗。

---

## Glassmorphism 面板

所有面板統一使用 `.glass-panel`：

```css
.glass-panel {
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(51, 65, 85, 0.3);
  box-shadow: 0 4px 24px -2px rgba(0, 0, 0, 0.5);
}
```

搭配 Tailwind class：`rounded-lg border border-slate-700/50`

---

## 交易 UI 專屬元件

### DOM 五檔面板 (DOMPanel)

| 元素     | 樣式規則                                                                    |
| -------- | --------------------------------------------------------------------------- |
| 賣/買價  | `font-mono tabular-nums text-sm font-bold`                                  |
| 委託量   | `font-mono tabular-nums text-xs`                                            |
| 當前價   | `text-accent-amber font-black text-xl`                                      |
| 漲跌色   | Price > Reference → `text-buy-muted`；Price < Reference → `text-sell-muted` |
| 價格閃爍 | 上漲 → `animate-flash-inc` (金色閃一下)；下跌 → `animate-flash-dec` (淡出)  |
| 成交閃爍 | 有量更新時 → `animate-tick` (背景金色閃)                                    |

### 報價閃爍動畫

```css
/* 上漲閃爍 — 金色放大 → 恢復 */
.animate-flash-inc {
  animation: text-flash-inc 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

/* 下跌閃爍 — 淡出 → 恢復 */
.animate-flash-dec {
  animation: text-flash-dec 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

/* 成交背景閃 — 金色背景 → 透明 */
.animate-tick {
  animation: bg-flash-tick 0.35s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}
```

### Header (頂部導覽列)

| 元素        | 樣式                                                               |
| ----------- | ------------------------------------------------------------------ |
| LOGO        | `font-black tracking-[0.2em] italic font-mono text-lg`             |
| 連線燈號    | ONLINE → `bg-[#10B981]` 帶 `shadow-glow`；OFFLINE → `bg-[#EF4444]` |
| SYMBOL 輸入 | `bg-slate-900 border-slate-700 font-mono font-bold`                |
| LOAD 按鈕   | `hover:bg-accent-amber hover:text-white`                           |

### 帳戶面板

| 元素         | 樣式                                                           |
| ------------ | -------------------------------------------------------------- |
| 損益正/負    | `text-buy-muted` / `text-sell-muted`                           |
| 模擬模式標示 | `bg-amber-500/20 text-amber-400 text-[10px] rounded-full px-2` |

---

## 間距系統

| Token | Value         | 用途             |
| ----- | ------------- | ---------------- |
| `xs`  | 4px / 0.25rem | 密集數據間距     |
| `sm`  | 8px / 0.5rem  | 圖示間距         |
| `md`  | 16px / 1rem   | 標準面板 padding |
| `lg`  | 24px / 1.5rem | 區塊間距         |
| `xl`  | 32px / 2rem   | 大區塊分隔       |

---

## 陰影層級

| Level | Value                          | 用途       |
| ----- | ------------------------------ | ---------- |
| `sm`  | `0 1px 2px rgba(0,0,0,0.05)`   | 微浮起     |
| `md`  | `0 4px 6px rgba(0,0,0,0.1)`    | 面板、按鈕 |
| `lg`  | `0 10px 15px rgba(0,0,0,0.1)`  | 彈窗、下拉 |
| `xl`  | `0 20px 25px rgba(0,0,0,0.15)` | 模態框     |

---

## 滾動條

```css
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: rgba(15, 23, 42, 0.5);
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(51, 65, 85, 0.8);
  border-radius: 3px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(71, 85, 105, 1);
}
```

---

## 禁止模式 (Anti-Patterns)

- ❌ **淺色背景**：嚴禁使用白色或淺色背景
- ❌ **歐美紅綠慣例**：紅色 ≠ 下跌、綠色 ≠ 上漲（台灣是相反的）
- ❌ **Emojis 當圖示**：使用 Lucide React SVG 圖示
- ❌ **缺少 cursor:pointer**：所有可互動元素必須有
- ❌ **瞬間狀態切換**：所有過渡必須加 `transition` (150–300ms)
- ❌ **非 tabular-nums 的數字**：報價/損益欄位必須使用等寬數字
- ❌ **固定寬度的文字**：報價數字不可用 `w-[80px]`，改用 `min-w-[80px]`

---

## 交付前檢查清單

在交付任何 UI 程式碼前，驗證：

- [ ] 所有色碼來自本文件的色彩系統
- [ ] 紅色 = 買入/上漲，綠色 = 賣出/下跌
- [ ] 報價數字使用 `tabular-nums` + `font-mono`
- [ ] 面板使用 `.glass-panel` 類別
- [ ] 所有可點擊元素有 `cursor-pointer`
- [ ] Hover 狀態有 150–300ms transition
- [ ] 圖示使用 Lucide React，不使用 emoji
- [ ] 響應式斷點：375px / 768px / 1024px / 1440px
- [ ] 無水平溢出滾動
- [ ] 報價閃爍動畫不超過 350ms
