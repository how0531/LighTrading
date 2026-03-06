"""
EventBus — 集中式事件分發匯流排

解耦 ShioajiClient、OrderManager、PositionTracker 與 UI/Backend 之間的通訊。
所有模組只依賴 EventBus，不直接引用彼此。
"""
import logging
import asyncio

logger = logging.getLogger(__name__)

class Signal:
    """純 Python 實現的簡單 Signal，用於取代 pyqtSignal"""
    def __init__(self):
        self._handlers = []

    def connect(self, handler):
        if handler not in self._handlers:
            self._handlers.append(handler)

    def disconnect(self, handler):
        if handler in self._handlers:
            self._handlers.remove(handler)

    def emit(self, *args, **kwargs):
        for handler in self._handlers:
            try:
                # 支援同步或非同步的 handler
                if asyncio.iscoroutinefunction(handler):
                    # 若為 coroutine，請注意這裡只是 fire and forget，不 await
                    # 如果需要嚴格的非同步控制，應由 handler 內部自行 create_task
                    try:
                        loop = asyncio.get_running_loop()
                        loop.create_task(handler(*args, **kwargs))
                    except RuntimeError:
                        asyncio.run(handler(*args, **kwargs))
                else:
                    handler(*args, **kwargs)
            except Exception as e:
                logger.error(f"執行 Signal handler {handler} 時發生錯誤: {e}", exc_info=True)


class EventBus:
    """
    全域事件匯流排 (Singleton-like, 由 main.py 建立並傳入各模組)

    使用方式:
        event_bus.on_tick.connect(my_handler)
        event_bus.on_tick.emit(symbol, tick_data)
    """
    def __init__(self):
        # ──── 行情事件 ────
        self.on_tick = Signal()           # (symbol, tick_data)
        self.on_bidask = Signal()         # (symbol, bidask_data)
        self.on_snapshot = Signal()       # (symbol, snapshot_data)

        # ──── 交易事件 ────
        self.on_order_update = Signal()        # OrderEntry dict
        self.on_fill = Signal()               # fill_data (成交回報)
        self.on_position_update = Signal()     # {symbol: PositionEntry}
        self.on_account_update = Signal()      # 帳務摘要

        # ──── 委託管理事件 ────
        self.on_order_placed = Signal()        # 下單成功
        self.on_order_cancelled = Signal()     # 刪單成功
        self.on_order_modified = Signal()      # 改單成功
        self.on_order_rejected = Signal()      # 委託被拒 (reason)

        # ──── 智慧單事件 ────
        self.on_smart_order_triggered = Signal()  # 觸價/移停觸發
        self.on_smart_order_added = Signal()      # 新增智慧單

        # ──── 系統事件 ────
        self.on_connection_state = Signal()     # "connected" | "disconnected" | "reconnecting"
        self.on_error = Signal()           # (level: "warning"|"error"|"critical", message)
        self.on_notification = Signal()    # (type: "info"|"success"|"warning", message)

        # ──── 風控事件 ────
        self.on_risk_breach = Signal()     # (level: "warning"|"block", message)

        # ──── 使用者操作事件 ────
        self.on_symbol_changed = Signal()       # 使用者切換商品
        self.on_qty_changed = Signal()          # 使用者調整預設口數
        
        logger.info("EventBus (純 Python 版) 已初始化")
