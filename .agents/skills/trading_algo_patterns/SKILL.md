---
name: Trading Algo Patterns
description: 專門實作交易軟體的進階委託 (Smart Orders)、洗價機制與全域快捷鍵 (Hotkeys) 的技能庫。
---

# Trading Algo Patterns 技能指南

在現代化看盤終端 (Lightning Trader) 中，速度與防呆機制是核心。此技能提供實作 Phase 2 高頻與進階交易功能的標準模式。

## 1. 快捷鍵綁定 (Hotkeys)
在 Qt 應用程式中，全域快捷鍵通常有兩種實作方式：`QShortcut` 與覆寫 `keyPressEvent`。

### 最佳實踐：使用 QShortcut
`QShortcut` 不需要視窗有焦點即可觸發，極度適合「市價全平倉」、「全刪單」等緊急避險操作。
```python
from PyQt5.QtWidgets import QShortcut
from PyQt5.QtGui import QKeySequence

class MainWindow(QMainWindow):
    def setup_hotkeys(self):
        # 綁定空白鍵 (Space) 為一鍵刪除所有委託
        shortcut_cancel_all = QShortcut(QKeySequence("Space"), self)
        shortcut_cancel_all.activated.connect(self.cancel_all_orders)

        # 綁定 Esc 鍵作為備用的安全防護
        shortcut_escape = QShortcut(QKeySequence("Esc"), self)
        shortcut_escape.activated.connect(self.emergency_stop)
```
**警告：** 使用快捷鍵下單或刪單時，務必在 StatusBar 顯示狀態更新，或是播放音效以提示操作者。

## 2. 觸價單與移動停損 (Stop & Trailing Stop)
大部份台灣券商 API (包含 Shioaji) 預設不直接支援雲端洗價的移動停損單（除非特定主機）。這代表你的交易軟體必須在 **本機端 (Client-side)** 進行價格監控 (洗價)。

### A. 觸價單 (Market If Touched, MIT)
**實作邏輯：**
1. 使用者設定 `觸發條件` (如大於等於 21000) 與 `下單動作` (市價買進)。
2. 每次 `update_tick` 或 `update_bidask` 收到新價格時，檢查是否滿足條件。
3. 條件滿足時，立刻呼叫 `place_order`，並從監控清單移除該條件。

### B. 移動停損單 (Trailing Stop)
**實作邏輯：**
這是一個動態跟隨行情的出場機制。
1. **設定參數**：啟動價格 `activation_price` (選擇性)、回檔幅度 `trailing_ticks` (例如 10 點)。
2. **多單情境**：
   - 記錄進場後的最高價 `highest_watermark`。
   - 停損觸發價 = `highest_watermark - trailing_ticks`。
   - 若市價跌破停損觸發價，立刻發送市價賣出平倉。
   - 如果市價創新高，更新 `highest_watermark`，停損觸發價也隨之提高！
3. **空單情境** (反之亦然)：
   - 記錄最低價 `lowest_watermark`。
   - 觸發價 = `lowest_watermark + trailing_ticks`。

```python
class TrailingStopMonitor:
    def __init__(self, action, trailing_ticks):
        self.action = action # Action.Buy (空單平倉) 或 Action.Sell (多單平倉)
        self.trailing_ticks = trailing_ticks
        self.watermark = None

    def on_new_tick(self, current_price):
        if self.watermark is None:
            self.watermark = current_price
            return False

        if self.action == Action.Sell: # 多單，尋找高點
            if current_price > self.watermark:
                self.watermark = current_price
            elif current_price <= self.watermark - self.trailing_ticks:
                return True # 觸發賣出停損！
```
*實作此機制時，請強烈建議將此監測器實例放在背景執行緒，以免佔用 UI 造成卡頓。*

## 3. 防呆與流量控制
1. **Button Debounce (防連點)**：
   每次點擊下單按鈕後，立刻 `setEnabled(False)` 並啟動 `QTimer.singleShot(500, lambda: btn.setEnabled(True))` 鎖定 0.5 秒，防止手震連下兩單。
2. **Maximum Position Limit (部位上限)**：
   在執行 `place_order` 前，必須檢查 `list_positions`，若累加的 qty 超過設定上限（預設例如 10 口），請直接駁回避免下錯單。
