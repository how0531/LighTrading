"""
EventBus — 集中式事件分發匯流排

解耦 ShioajiClient、OrderManager、PositionTracker 與 UI/Backend 之間的通訊。
所有模組只依賴 EventBus，不直接引用彼此。
"""
import logging
from PyQt5.QtCore import QObject, pyqtSignal

logger = logging.getLogger(__name__)


class EventBus(QObject):
    """
    全域事件匯流排 (Singleton-like, 由 main.py 建立並傳入各模組)

    使用方式:
        event_bus.on_tick.connect(my_handler)
        event_bus.on_tick.emit(symbol, tick_data)
    """

    # ──── 行情事件 ────
    on_tick = pyqtSignal(str, dict)           # (symbol, tick_data)
    on_bidask = pyqtSignal(str, dict)         # (symbol, bidask_data)
    on_snapshot = pyqtSignal(str, dict)       # (symbol, snapshot_data)

    # ──── 交易事件 ────
    on_order_update = pyqtSignal(dict)        # OrderEntry dict
    on_fill = pyqtSignal(dict)               # fill_data (成交回報)
    on_position_update = pyqtSignal(dict)     # {symbol: PositionEntry}
    on_account_update = pyqtSignal(dict)      # 帳務摘要

    # ──── 委託管理事件 ────
    on_order_placed = pyqtSignal(dict)        # 下單成功
    on_order_cancelled = pyqtSignal(dict)     # 刪單成功
    on_order_modified = pyqtSignal(dict)      # 改單成功
    on_order_rejected = pyqtSignal(str)       # 委託被拒 (reason)

    # ──── 智慧單事件 ────
    on_smart_order_triggered = pyqtSignal(dict)  # 觸價/移停觸發
    on_smart_order_added = pyqtSignal(dict)      # 新增智慧單

    # ──── 系統事件 ────
    on_connection_state = pyqtSignal(str)     # "connected" | "disconnected" | "reconnecting"
    on_error = pyqtSignal(str, str)           # (level: "warning"|"error"|"critical", message)
    on_notification = pyqtSignal(str, str)    # (type: "info"|"success"|"warning", message)

    # ──── 風控事件 ────
    on_risk_breach = pyqtSignal(str, str)     # (level: "warning"|"block", message)

    # ──── 使用者操作事件 ────
    on_symbol_changed = pyqtSignal(str)       # 使用者切換商品
    on_qty_changed = pyqtSignal(int)          # 使用者調整預設口數

    def __init__(self, parent=None):
        super().__init__(parent)
        logger.info("EventBus 已初始化")
