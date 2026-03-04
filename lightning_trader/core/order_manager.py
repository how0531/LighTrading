"""
OrderManager — 訂單生命週期管理

維護本地訂單簿，透過 Shioaji 的 on_order_status callback 即時更新。
提供 working_orders / filled_today 等查詢介面。
"""
import logging
from enum import Enum
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field
from datetime import datetime

from PyQt5.QtCore import QObject

logger = logging.getLogger(__name__)


class OrderStatus(Enum):
    """訂單狀態"""
    PENDING_SUBMIT = "PendingSubmit"
    PRE_SUBMITTED = "PreSubmitted"
    SUBMITTED = "Submitted"
    PARTIAL_FILLED = "PartialFilled"
    FILLED = "Filled"
    CANCELLED = "Cancelled"
    FAILED = "Failed"


@dataclass
class OrderEntry:
    """單筆委託記錄"""
    order_id: str
    symbol: str
    action: str                    # "Buy" | "Sell"
    price: float
    qty: int
    filled_qty: int = 0
    avg_fill_price: float = 0.0
    status: OrderStatus = OrderStatus.PENDING_SUBMIT
    order_type: str = "ROD"        # ROD / IOC / FOK
    price_type: str = "LMT"       # LMT / MKT
    account_id: str = ""
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    trade_ref: Any = None          # 保留 shioaji Trade 物件的引用

    def to_dict(self) -> dict:
        return {
            "order_id": self.order_id,
            "symbol": self.symbol,
            "action": self.action,
            "price": self.price,
            "qty": self.qty,
            "filled_qty": self.filled_qty,
            "avg_fill_price": self.avg_fill_price,
            "status": self.status.value,
            "order_type": self.order_type,
            "price_type": self.price_type,
            "account_id": self.account_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @property
    def is_working(self) -> bool:
        """是否為未完成的活躍委託"""
        return self.status in (
            OrderStatus.PENDING_SUBMIT,
            OrderStatus.PRE_SUBMITTED,
            OrderStatus.SUBMITTED,
            OrderStatus.PARTIAL_FILLED,
        )

    @property
    def remaining_qty(self) -> int:
        return self.qty - self.filled_qty


class OrderManager(QObject):
    """
    訂單管理器

    使用方式:
        om = OrderManager(event_bus)
        # ShioajiClient 回報時呼叫
        om.on_order_status_callback(status, msg)
        # 查詢
        working = om.get_working_orders("TXFD5")
        filled = om.get_filled_today()
    """

    def __init__(self, event_bus):
        super().__init__()
        self.event_bus = event_bus
        self._orders: Dict[str, OrderEntry] = {}
        self._fill_count = 0    # 今日成交筆數
        self._msg_count = 0     # 訊息計數器（供前端 dependency 使用）
        logger.info("OrderManager 已初始化")

    # ──── 訂單記錄 ────

    def register_order(self, trade, symbol: str, action: str, price: float,
                       qty: int, order_type: str = "ROD", price_type: str = "LMT",
                       account_id: str = "") -> OrderEntry:
        """下單後將 trade 物件註冊到本地訂單簿"""
        order_id = getattr(trade, 'order', None)
        if order_id and hasattr(order_id, 'id'):
            order_id = order_id.id
        else:
            order_id = f"local_{len(self._orders)}_{datetime.now().strftime('%H%M%S%f')}"

        entry = OrderEntry(
            order_id=str(order_id),
            symbol=symbol.strip().upper(),
            action=action,
            price=price,
            qty=qty,
            order_type=order_type,
            price_type=price_type,
            account_id=account_id,
            trade_ref=trade,
        )
        self._orders[entry.order_id] = entry
        self.event_bus.on_order_placed.emit(entry.to_dict())
        logger.info(f"[OrderManager] 註冊委託 {entry.order_id}: "
                    f"{entry.action} {entry.symbol} {entry.qty}@{entry.price}")
        return entry

    # ──── 狀態更新 (由 ShioajiClient callback 呼叫) ────

    def on_order_status_callback(self, status, msg: dict):
        """
        處理 Shioaji on_order_status 回調

        msg 格式範例:
        {
            "id": "...",
            "status": "Filled",
            "code": "2330",
            "action": "Buy",
            "price": 955.0,
            "quantity": 1,
            "msg": "..."
        }
        """
        order_id = str(msg.get("id", ""))
        self._msg_count += 1

        if order_id in self._orders:
            entry = self._orders[order_id]
            old_status = entry.status
            new_status_str = msg.get("status", "")
            try:
                new_status = OrderStatus(new_status_str)
            except ValueError:
                logger.warning(f"未知的訂單狀態: {new_status_str}")
                return

            entry.status = new_status
            entry.updated_at = datetime.now().isoformat()

            # 更新成交資訊
            if new_status in (OrderStatus.PARTIAL_FILLED, OrderStatus.FILLED):
                fill_qty = int(msg.get("quantity", 0))
                fill_price = float(msg.get("price", 0))
                if fill_qty > 0 and fill_price > 0:
                    old_total = entry.avg_fill_price * entry.filled_qty
                    entry.filled_qty += fill_qty
                    entry.avg_fill_price = (old_total + fill_price * fill_qty) / entry.filled_qty

                    # 發射成交事件
                    self.event_bus.on_fill.emit({
                        "order_id": order_id,
                        "symbol": entry.symbol,
                        "action": entry.action,
                        "fill_price": fill_price,
                        "fill_qty": fill_qty,
                        "total_filled": entry.filled_qty,
                        "remaining": entry.remaining_qty,
                    })
                    self._fill_count += 1
                    logger.info(f"[OrderManager] 成交 {entry.symbol} "
                                f"{entry.action} {fill_qty}@{fill_price}")

            # 發射訂單更新事件
            self.event_bus.on_order_update.emit(entry.to_dict())

            if old_status != new_status:
                logger.info(f"[OrderManager] 訂單 {order_id} 狀態變更: "
                            f"{old_status.value} → {new_status.value}")
        else:
            # 外部來源的訂單（如其他平台下的）也記錄
            logger.debug(f"[OrderManager] 收到未註冊的訂單狀態: {order_id}")

    # ──── 查詢介面 ────

    def get_working_orders(self, symbol: Optional[str] = None) -> List[OrderEntry]:
        """取得掛單中的委託"""
        orders = [o for o in self._orders.values() if o.is_working]
        if symbol:
            symbol = symbol.strip().upper()
            orders = [o for o in orders if o.symbol == symbol]
        return orders

    def get_working_orders_at_price(self, symbol: str, action: str, price: float) -> List[OrderEntry]:
        """取得特定價位的掛單"""
        symbol = symbol.strip().upper()
        return [
            o for o in self._orders.values()
            if o.is_working and o.symbol == symbol
            and o.action == action and o.price == price
        ]

    def get_filled_today(self) -> List[OrderEntry]:
        """取得今日已成交的委託"""
        return [o for o in self._orders.values()
                if o.status in (OrderStatus.FILLED, OrderStatus.PARTIAL_FILLED)
                and o.filled_qty > 0]

    def get_all_orders(self) -> List[OrderEntry]:
        """取得所有委託"""
        return list(self._orders.values())

    @property
    def fill_count(self) -> int:
        return self._fill_count

    @property
    def working_count(self) -> int:
        return len(self.get_working_orders())

    @property
    def msg_count(self) -> int:
        return self._msg_count

    def get_summary(self) -> dict:
        """取得訂單摘要（供前端 StatusBar 使用）"""
        return {
            "total_orders": len(self._orders),
            "working_count": self.working_count,
            "fill_count": self.fill_count,
            "msg_count": self._msg_count,
        }
