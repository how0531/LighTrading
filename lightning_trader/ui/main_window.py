import sys
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, 
    QLabel, QLineEdit, QPushButton, QTableWidget, QTableWidgetItem, 
    QHeaderView, QSpinBox, QComboBox, QGridLayout, QFrame, QMessageBox,
    QDockWidget, QShortcut
)
from PyQt5.QtCore import Qt, pyqtSlot, QTimer, QSettings
from PyQt5.QtGui import QColor, QFont, QKeySequence
from shioaji.constant import Action

class LightningOrderWindow(QMainWindow):
    def __init__(self, client):
        super().__init__()
        self.client = client
        self.initUI()
        self.setup_signals()
        
        # 綁定全域快捷鍵
        self.setup_hotkeys()

        self.current_bids = []
        self.current_asks = []
        self.last_price = 0

    def initUI(self):
        self.setWindowTitle('閃電下單 - 專業看盤終端')
        self.resize(1200, 850)
        
        # 套用現代化深色主題 (Navy & Gold Dark Mode)
        self.setStyleSheet("""
            QMainWindow { background-color: #161C2D; }
            QLabel { color: #A0AABF; font-weight: 500; font-size: 13px; font-family: "Fira Sans", sans-serif; }
            QLineEdit, QSpinBox, QComboBox {
                background-color: #1D263B; color: #F5F6FA;
                border: 1px solid #435B83; padding: 6px;
                border-radius: 4px; font-size: 13px;
                font-family: "Fira Code", monospace;
            }
            QLineEdit:focus, QSpinBox:focus { border: 1px solid #E2B25A; }
            QPushButton {
                background-color: #2C3E5D; color: #E2E8F0;
                border: 1px solid #435B83; padding: 8px 16px;
                border-radius: 4px; font-weight: bold; font-size: 13px;
                font-family: "Fira Sans", sans-serif;
            }
            QPushButton:hover { background-color: #435B83; color: white; }
            QTableWidget {
                background-color: #1D263B; color: #F5F6FA;
                gridline-color: #2C3E5D; border: none;
                border-radius: 0px; font-size: 14px;
                font-family: "Fira Code", monospace;
            }
            QHeaderView::section {
                background-color: #161C2D; color: #8BA2C4;
                padding: 6px; border: 1px solid #2C3E5D; 
                font-weight: normal; font-size: 11px;
                font-family: "Fira Sans", sans-serif;
            }
            QDockWidget {
                color: #A0AABF;
                font-weight: normal;
                background: #161C2D;
                font-family: "Fira Sans", sans-serif;
            }
            QDockWidget::title {
                background: #1D263B;
                padding-left: 10px;
                padding-top: 4px;
            }
        """)


        # -----------------------------
        # Central Widget (閃電下單表格)
        # -----------------------------
        self.table = QTableWidget(11, 9)
        self.table.setHorizontalHeaderLabels([
            "刪買", "MIT買", "點擊買進", "委買留單", "價 格", "委賣留單", "點擊賣出", "MIT賣", "刪賣"
        ])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setSelectionMode(QTableWidget.NoSelection)
        self.table.setShowGrid(False) # 隱藏冰冷的死板線條，改用 CSS 的 border-bottom 表現
        self.table.verticalHeader().setDefaultSectionSize(52) # 稍微再加大一點以容納 padding
        self.table.cellClicked.connect(self.on_cell_clicked)
        self.table.setStyleSheet(self.table.styleSheet() + "QTableWidget::item:hover { background-color: rgba(255,255,255,0.1); }")
        
        self.init_table_ui()
        
        # 建立報價表的 Dock
        self.dock_bidask = QDockWidget("五檔報價區", self)
        self.dock_bidask.setObjectName("dock_bidask")
        self.dock_bidask.setWidget(self.table)
        self.dock_bidask.setAllowedAreas(Qt.AllDockWidgetAreas)
        self.addDockWidget(Qt.LeftDockWidgetArea, self.dock_bidask)

        self.setCentralWidget(None)
        self.setDockNestingEnabled(True)

        # -----------------------------
        # Dock Widget 1: 控制面板 (左側)
        # -----------------------------
        self.dock_control = QDockWidget("控制面板", self)
        self.dock_control.setObjectName("dock_control")
        self.dock_control.setAllowedAreas(Qt.LeftDockWidgetArea | Qt.RightDockWidgetArea)
        
        control_panel = QFrame()
        control_panel.setObjectName("ControlPanel") # 綁定 CSS 樣式
        control_layout = QVBoxLayout(control_panel)
        control_layout.setContentsMargins(16, 16, 16, 16) # 加大內部留白
        control_layout.setSpacing(16)
        
        # 基本控制
        base_ctrl_layout = QGridLayout()
        base_ctrl_layout.addWidget(QLabel("商品:"), 0, 0)
        self.symbol_input = QLineEdit("FITX")
        self.symbol_input.setAlignment(Qt.AlignCenter)
        base_ctrl_layout.addWidget(self.symbol_input, 0, 1)
        
        self.btn_subscribe = QPushButton("即時訂閱")
        self.btn_subscribe.clicked.connect(self.on_subscribe_clicked)
        base_ctrl_layout.addWidget(self.btn_subscribe, 0, 2)
        
        base_ctrl_layout.addWidget(QLabel("口數:"), 1, 0)
        self.qty_spinbox = QSpinBox()
        self.qty_spinbox.setMinimum(1)
        self.qty_spinbox.setMaximum(999)
        self.qty_spinbox.setValue(1)
        self.qty_spinbox.setAlignment(Qt.AlignCenter)
        base_ctrl_layout.addWidget(self.qty_spinbox, 1, 1)
        
        control_layout.addLayout(base_ctrl_layout)
        
        # 智慧單控制 (停損 / 移動停損)
        control_layout.addWidget(QLabel("--- 智慧單設定 (本地端) ---"))
        smart_ctrl_layout = QGridLayout()
        
        smart_ctrl_layout.addWidget(QLabel("固定停損點位:"), 0, 0)
        self.stop_price_input = QSpinBox()
        self.stop_price_input.setMaximum(99999)
        self.stop_price_input.setValue(0)
        smart_ctrl_layout.addWidget(self.stop_price_input, 0, 1)

        smart_ctrl_layout.addWidget(QLabel("移動停損點數:"), 1, 0)
        self.trailing_stop_input = QSpinBox()
        self.trailing_stop_input.setMaximum(9999)
        self.trailing_stop_input.setValue(0)
        smart_ctrl_layout.addWidget(self.trailing_stop_input, 1, 1)
        
        self.btn_add_smart_buy = QPushButton("新增買進智慧單")
        self.btn_add_smart_buy.setStyleSheet("background-color: #166534;")
        self.btn_add_smart_buy.clicked.connect(lambda: self.on_add_smart_order(Action.Buy))
        smart_ctrl_layout.addWidget(self.btn_add_smart_buy, 2, 0, 1, 2)

        self.btn_add_smart_sell = QPushButton("新增賣出智慧單")
        self.btn_add_smart_sell.setStyleSheet("background-color: #991B1B;")
        self.btn_add_smart_sell.clicked.connect(lambda: self.on_add_smart_order(Action.Sell))
        smart_ctrl_layout.addWidget(self.btn_add_smart_sell, 3, 0, 1, 2)
        
        control_layout.addLayout(smart_ctrl_layout)
        control_layout.addStretch()
        
        self.dock_control.setWidget(control_panel)
        self.addDockWidget(Qt.LeftDockWidgetArea, self.dock_control)

        # -----------------------------
        # Dock Widget 2: 帳戶與部位 (右側)
        # -----------------------------
        self.dock_account = QDockWidget("帳戶與部位總覽", self)
        self.dock_account.setObjectName("dock_account")
        self.dock_account.setAllowedAreas(Qt.LeftDockWidgetArea | Qt.RightDockWidgetArea)
        
        right_panel = QFrame()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(16, 16, 16, 16)
        
        self.acct_table = QTableWidget(7, 2)
        self.acct_table.setHorizontalHeaderLabels(["項目", "即時數值"])
        self.acct_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.acct_table.verticalHeader().setVisible(False)
        self.acct_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.acct_table.setSelectionMode(QTableWidget.NoSelection)
        self.acct_table.verticalHeader().setDefaultSectionSize(40)
        
        items = ["當日交易", "委託", "刪單", "未成交", "成交", "未平倉", "參考損益"]
        for i, item in enumerate(items):
            self.acct_table.setItem(i, 0, QTableWidgetItem(item))
            self.acct_table.setItem(i, 1, QTableWidgetItem("0"))
            self.acct_table.item(i, 0).setTextAlignment(Qt.AlignCenter)
            self.acct_table.item(i, 1).setTextAlignment(Qt.AlignCenter)
        
        right_layout.addWidget(self.acct_table)
        
        self.btn_refresh_acct = QPushButton("重新同步帳務")
        self.btn_refresh_acct.setStyleSheet("background-color: #475569; padding: 12px;")
        self.btn_refresh_acct.clicked.connect(self.client.update_status)
        right_layout.addWidget(self.btn_refresh_acct)
        
        right_layout.addStretch()
        self.dock_account.setWidget(right_panel)
        self.addDockWidget(Qt.RightDockWidgetArea, self.dock_account)

        # -----------------------------
        # 載入上次的版面佈局 (Dynamic Workspace)
        # -----------------------------
        self.settings = QSettings("layout.ini", QSettings.IniFormat)
        if self.settings.value("geometry"):
            self.restoreGeometry(self.settings.value("geometry"))
        if self.settings.value("windowState"):
            self.restoreState(self.settings.value("windowState"))

    def closeEvent(self, event):
        """關閉視窗時，儲存版面佈局狀態"""
        self.settings.setValue("geometry", self.saveGeometry())
        self.settings.setValue("windowState", self.saveState())
        super().closeEvent(event)

    def init_table_ui(self):
        color_buy_deep = QColor(28, 25, 23)     # 深度低調紅黑
        color_buy = QColor(69, 10, 10, 180)     # 低飽和深紅
        color_buy_light = QColor(153, 27, 27, 40) # 極淡紅背板
        
        color_sell_deep = QColor(2, 43, 58)     # 深度低調藍綠黑
        color_sell = QColor(12, 74, 110, 180)   # 低飽和深藍
        color_sell_light = QColor(2, 132, 199, 40) # 極淡藍背板
        
        color_price = QColor(29, 38, 59)        # Navy Panel (#1D263B)
        
        font_mono = QFont("Fira Code")
        font_mono.setBold(True)
        font_mono.setPointSize(10)
        font_mono.setStyleHint(QFont.Monospace)

        for row in range(11):
            for col in range(9):
                item = QTableWidgetItem("")
                item.setTextAlignment(Qt.AlignCenter)
                item.setFont(font_mono)
                
                if col in [0, 1]:
                    item.setBackground(color_buy_deep)
                    item.setForeground(QColor("#7F1D1D"))
                    if col == 0:
                        font_del = QFont("Fira Sans")
                        font_del.setPointSize(9)
                        item.setFont(font_del)
                elif col == 2:
                    item.setBackground(color_buy)
                    item.setForeground(QColor("#FECACA"))
                elif col == 3:
                    item.setBackground(color_buy_light)
                    item.setForeground(QColor("#F8FAFC"))
                elif col == 4:
                    item.setBackground(color_price)
                    item.setForeground(QColor("#E2B25A")) # Dawho Gold
                    font_price = QFont("Fira Code")
                    font_price.setBold(True)
                    font_price.setPointSize(12)
                    item.setFont(font_price)
                elif col == 5:
                    item.setBackground(color_sell_light)
                    item.setForeground(QColor("#F8FAFC"))
                elif col == 6:
                    item.setBackground(color_sell)
                    item.setForeground(QColor("#BAE6FD"))
                elif col in [7, 8]:
                    item.setBackground(color_sell_deep)
                    item.setForeground(QColor("#083344"))
                    if col == 8:
                        font_del = QFont("Fira Sans")
                        font_del.setPointSize(9)
                        item.setFont(font_del)
                    
                self.table.setItem(row, col, item)

    def setup_signals(self):
        self.client.signal_quote_tick.connect(self.update_tick)
        self.client.signal_quote_bidask.connect(self.update_bidask)
        self.client.signal_login_status.connect(self.on_login_status)
        self.client.signal_account_update.connect(self.update_account_info)

    def setup_hotkeys(self):
        """設定全域快捷鍵 (Smart Orders & Hotkeys)"""
        # Space 空白鍵：自動市價買進
        self.shortcut_space = QShortcut(QKeySequence(Qt.Key_Space), self)
        self.shortcut_space.activated.connect(self.on_spacebar_pressed)

    def on_spacebar_pressed(self):
        """快捷鍵：空白鍵觸發市價買進"""
        symbol = self.symbol_input.text().strip()
        qty = self.qty_spinbox.value()
        if symbol:
            self.client.place_order(symbol, price=0, action=Action.Buy, qty=qty)
            self.statusBar().showMessage(f"[快捷鍵] 送出買進市價(MIT)單: {symbol} {qty}口")

    def on_subscribe_clicked(self):
        symbol = self.symbol_input.text().strip()
        if symbol:
            self.client.subscribe(symbol)
            self.setWindowTitle(f"閃電下單 - 訂閱中: {symbol}")

    def on_add_smart_order(self, action):
        """新增智慧單邏輯"""
        sender = self.sender()
        if isinstance(sender, QPushButton):
            sender.setEnabled(False)
            QTimer.singleShot(500, lambda: sender.setEnabled(True))
            
        symbol = self.symbol_input.text().strip()
        qty = self.qty_spinbox.value()
        stop_price = self.stop_price_input.value()
        trailing_offset = self.trailing_stop_input.value()
        
        if symbol:
            self.client.add_smart_order(symbol, action, qty, stop_price, trailing_offset)
            msg = f"已新增{'買進' if action==Action.Buy else '賣出'}智慧單: {symbol} {qty}口, 停損:{stop_price}, 移停:{trailing_offset}"
            self.statusBar().showMessage(msg)

    def on_cell_clicked(self, row, col):
        price_str = self.table.item(row, 4).text()
        if not price_str: return
            
        try:
            price = float(price_str)
        except ValueError:
            return

        qty = self.qty_spinbox.value()
        symbol = self.symbol_input.text().strip()

        if col == 2:   
            self.client.place_order(symbol, price=price, action=Action.Buy, qty=qty)
            self.statusBar().showMessage(f"送出買進限價單: {price} {qty}口")
        elif col == 6: 
            self.client.place_order(symbol, price=price, action=Action.Sell, qty=qty)
            self.statusBar().showMessage(f"送出賣出限價單: {price} {qty}口")
        elif col == 1: 
            self.client.place_order(symbol, price=0, action=Action.Buy, qty=qty)
            self.statusBar().showMessage(f"送出買進市價(MIT)單: {qty}口")
        elif col == 7: 
            self.client.place_order(symbol, price=0, action=Action.Sell, qty=qty)
            self.statusBar().showMessage(f"送出賣出市價(MIT)單: {qty}口")
        elif col == 0: 
            self.client.cancel_orders_by_action_price(symbol, Action.Buy, price)
            self.statusBar().showMessage(f"刪除買進委託: {price}")
        elif col == 8: 
            self.client.cancel_orders_by_action_price(symbol, Action.Sell, price)
            self.statusBar().showMessage(f"刪除賣出委託: {price}")

    @pyqtSlot(object)
    def update_tick(self, quote):
        try:
            price = quote.get('close', quote.get('Price', 0))
            if price:
                self.last_price = price
        except AttributeError:
             pass

    @pyqtSlot(object)
    def update_bidask(self, quote):
        try:
            asks = quote.get('ask_price', [])
            ask_vols = quote.get('ask_volume', [])
            bids = quote.get('bid_price', [])
            bid_vols = quote.get('bid_volume', [])
            
            for i in range(5):
                if i < len(asks):
                    row = 4 - i
                    self.table.item(row, 4).setText(str(asks[i]))
                    self.table.item(row, 5).setText(str(ask_vols[i]))
                
                if i < len(bids):
                    row = 6 + i
                    self.table.item(row, 4).setText(str(bids[i]))
                    self.table.item(row, 3).setText(str(bid_vols[i]))
            
        except AttributeError:
             pass

    @pyqtSlot(dict)
    def update_account_info(self, summary):
        items = ["當日交易", "委託", "刪單", "未成交", "成交", "未平倉", "參考損益"]
        for i, key in enumerate(items):
            if key in summary:
                val = summary[key]
                self.acct_table.item(i, 1).setText(str(val))

    @pyqtSlot(bool, str)
    def on_login_status(self, success, msg):
        title = self.windowTitle().split(" - ")[0]
        if success:
             self.setWindowTitle(f"{title} - 已連線")
             self.client.update_status()
             # 連線成功後，自動幫使用者按下「即時訂閱」按鈕以取得商品資料
             self.on_subscribe_clicked()
        else:
             self.setWindowTitle(f"{title} - 連線失敗: {msg}")
             QMessageBox.warning(self, "登入失敗", msg)
