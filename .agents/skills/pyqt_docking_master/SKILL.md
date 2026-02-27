---
name: PyQt5 Docking Master
description: 專門協助構建 PyQt5 高階動態版面 (QDockWidget) 與狀態存檔 (saveState/restoreState) 的 UI 架構技能。
---

# PyQt5 Docking Master 技能指南

本技能提供在 PyQt5 中建立專業級、可自訂、可紀錄狀態的交易終端機版面架構標準。當使用者或指揮官要求**動態版面、可拖曳視窗、版面記憶**時，請嚴格遵守以下實作準則。

## 1. 核心觀念：QMainWindow 與 QDockWidget
在 PyQt5 中，要實現強大的浮動面板，必須依賴 `QMainWindow` 的內建 Dock 功能，不能只用 `QWidget` 與 Layout。

- **特點**：面板可以吸附在主視窗的上下左右 (DockAreas)，也可以扯下來變成獨立的浮動視窗 (Floating)。
- **限制**：`QMainWindow` 必須要有一個 CentralWidget，即使是空的。

## 2. 實作準則與最佳實踐

### A. 初始化 Dock Widget
```python
from PyQt5.QtWidgets import QDockWidget
from PyQt5.QtCore import Qt

dock = QDockWidget("五檔報價區", parent_window)
dock.setWidget(your_internal_widget) # 放入你的 QTableWidget 或 QFrame
dock.setAllowedAreas(Qt.LeftDockWidgetArea | Qt.RightDockWidgetArea)
dock.setObjectName("dock_bidask") # 極為重要！必須設定 ObjectName 才能記住狀態

# 加入主視窗
parent_window.addDockWidget(Qt.LeftDockWidgetArea, dock)
```

### B. 取消 Central Widget (完全 Dock 化)
許多專業看盤軟體沒有中央視窗，全由 Dock 組成：
```python
parent_window.setCentralWidget(None)
parent_window.setDockNestingEnabled(True) # 允許 Dock 相互嵌套與並排
```

### C. 狀態儲存與還原 (版面記憶功能)
這是交易軟體的靈魂！使用者排好版面後，下次開啟必須一模一樣。
利用 `QByteArray` 將版面狀態轉為 hex string 存入 `QSettings` 或是 JSON。

**儲存版面 (關閉時呼叫)：**
```python
from PyQt5.QtCore import QSettings

settings = QSettings("MyCompany", "LightningTrader")
settings.setValue("geometry", parent_window.saveGeometry())
settings.setValue("windowState", parent_window.saveState())
```

**還原版面 (啟動時呼叫)：**
```python
settings = QSettings("MyCompany", "LightningTrader")
if settings.value("geometry"):
    parent_window.restoreGeometry(settings.value("geometry"))
if settings.value("windowState"):
    parent_window.restoreState(settings.value("windowState"))
```
*警告：在呼叫 `restoreState` 之前，所有的 `QDockWidget` 必須已經被建立並且加入了 `QMainWindow`，且各自設定了唯一的 `setObjectName()`，否則還原會失敗！*

## 3. UI/UX 樣式 (Dark Mode 整合)
Dock Widget 的標題列必須自訂樣式才會好看：
```css
QDockWidget {
    color: #F8FAFC;
    font-weight: bold;
    titlebar-close-icon: url(close.png);
    titlebar-normal-icon: url(float.png);
}
QDockWidget::title {
    text-align: left;
    background: #0F172A;
    padding-left: 10px;
    padding-top: 4px;
}
```

## 面對專案的下一步
如果在 `lightning_trader` 中被呼叫，請將原本左側的「報價表」與右側的「帳務表」分別包裝進兩個 `QDockWidget` 中，並設定唯一的 ObjectName，最後在 `closeEvent` 中實作存檔邏輯。
