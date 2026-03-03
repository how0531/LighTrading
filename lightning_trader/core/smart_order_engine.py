"""
SmartOrderEngine — 本地端智慧委託引擎

監聽 EventBus 的 tick 事件，對所有活躍的智慧單進行洗價檢查。
當條件滿足時，透過 ShioajiClient 自動送出實際委託。

支援的智慧單類型:
  - MIT (Market If Touched): 觸價單
  - TrailingStop: 移動停損
  - OCO (One Cancels Other): 停利停損二擇一
  - Bracket: 進場後自動掛停利 + 停損
"""
import logging
from enum import Enum
from typing import List, Optional, Callable
from dataclasses import dataclass, field
from datetime import datetime

from PyQt5.QtCore import QObject, QTimer

logger = logging.getLogger(__name__)


class SmartOrderType(Enum):
    MIT = "MIT"                    # Market If Touched (觸價單)
    TRAILING_STOP = "TrailingStop" # 移動停損
    OCO = "OCO"                    # One Cancels Other
    BRACKET = "Bracket"            # 進場後自動掛停利停損


class TriggerCondition(Enum):
    PRICE_GTE = "price_gte"   # 價格 >= 觸發價 (用於買進觸價/空頭停損)
    PRICE_LTE = "price_lte"   # 價格 <= 觸發價 (用於賣出觸價/多頭停損)


@dataclass
class SmartOrder:
    """智慧單定義"""
    id: str
    symbol: str
    order_type: SmartOrderType
    action: str                    # "Buy" | "Sell"
    qty: int
    # 觸發條件
    trigger_condition: TriggerCondition = TriggerCondition.PRICE_LTE
    trigger_price: float = 0.0
    # 移動停損專用
    trailing_offset: float = 0.0   # 回檔點數
    watermark: Optional[float] = None  # 追蹤最高/最低價
    # OCO 專用
    take_profit_price: float = 0.0
    stop_loss_price: float = 0.0
    linked_id: Optional[str] = None  # OCO 配對的另一張單 ID
    # Bracket 專用
    parent_order_id: Optional[str] = None  # 母單 ID
    # 狀態
    is_active: bool = True
    is_triggered: bool = False
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    triggered_at: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "order_type": self.order_type.value,
            "action": self.action,
            "qty": self.qty,
            "trigger_condition": self.trigger_condition.value,
            "trigger_price": self.trigger_price,
            "trailing_offset": self.trailing_offset,
            "watermark": self.watermark,
            "take_profit_price": self.take_profit_price,
            "stop_loss_price": self.stop_loss_price,
            "is_active": self.is_active,
            "is_triggered": self.is_triggered,
            "created_at": self.created_at,
            "triggered_at": self.triggered_at,
        }


class SmartOrderEngine(QObject):
    """
    智慧委託引擎

    使用方式:
        engine = SmartOrderEngine(event_bus, place_order_fn)
        engine.add_mit("TXFD5", "Sell", 1, trigger_price=21000, condition="price_gte")
        engine.add_trailing_stop("TXFD5", "Sell", 1, trailing_offset=20)
        engine.add_oco("TXFD5", "Sell", 1, take_profit=21100, stop_loss=20900)
    """

    def __init__(self, event_bus, place_order_fn: Callable):
        """
        Args:
            event_bus: EventBus 實例
            place_order_fn: 實際下單函數，簽名為 (symbol, price, action, qty) -> trade
        """
        super().__init__()
        self.event_bus = event_bus
        self._place_order = place_order_fn
        self._smart_orders: List[SmartOrder] = []
        self._id_counter = 0

        # 監聽 tick 事件
        self.event_bus.on_tick.connect(self._on_tick)
        # 監聽成交事件 (用於 Bracket 單的母單成交偵測)
        self.event_bus.on_fill.connect(self._on_fill)

        logger.info("SmartOrderEngine 已初始化")

    def _next_id(self) -> str:
        self._id_counter += 1
        return f"SMART_{self._id_counter:04d}"

    # ──── 新增智慧單 ────

    def add_mit(self, symbol: str, action: str, qty: int,
                trigger_price: float, condition: str = "price_lte") -> SmartOrder:
        """新增觸價單 (Market If Touched)"""
        cond = TriggerCondition.PRICE_GTE if condition == "price_gte" else TriggerCondition.PRICE_LTE
        order = SmartOrder(
            id=self._next_id(),
            symbol=symbol.strip().upper(),
            order_type=SmartOrderType.MIT,
            action=action,
            qty=qty,
            trigger_condition=cond,
            trigger_price=trigger_price,
        )
        self._smart_orders.append(order)
        self.event_bus.on_smart_order_added.emit(order.to_dict())
        logger.info(f"[SmartOrder] 新增觸價單 {order.id}: "
                    f"{action} {symbol} {qty}口 @ 觸發={trigger_price} ({condition})")
        return order

    def add_trailing_stop(self, symbol: str, action: str, qty: int,
                          trailing_offset: float) -> SmartOrder:
        """新增移動停損單"""
        # 多頭平倉 → 賣出 → 追蹤最高價 → 回檔條件 PRICE_LTE
        # 空頭平倉 → 買進 → 追蹤最低價 → 回升條件 PRICE_GTE
        cond = TriggerCondition.PRICE_LTE if action == "Sell" else TriggerCondition.PRICE_GTE
        order = SmartOrder(
            id=self._next_id(),
            symbol=symbol.strip().upper(),
            order_type=SmartOrderType.TRAILING_STOP,
            action=action,
            qty=qty,
            trigger_condition=cond,
            trailing_offset=trailing_offset,
        )
        self._smart_orders.append(order)
        self.event_bus.on_smart_order_added.emit(order.to_dict())
        logger.info(f"[SmartOrder] 新增移動停損 {order.id}: "
                    f"{action} {symbol} {qty}口, 回檔={trailing_offset}點")
        return order

    def add_oco(self, symbol: str, action: str, qty: int,
                take_profit: float, stop_loss: float) -> str:
        """
        新增 OCO (One Cancels Other) 停利停損二擇一
        回傳主 ID (take_profit 那張)
        """
        tp_id = self._next_id()
        sl_id = self._next_id()

        # 停利單
        tp_order = SmartOrder(
            id=tp_id,
            symbol=symbol.strip().upper(),
            order_type=SmartOrderType.OCO,
            action=action,
            qty=qty,
            trigger_condition=TriggerCondition.PRICE_GTE if action == "Sell" else TriggerCondition.PRICE_LTE,
            trigger_price=take_profit,
            take_profit_price=take_profit,
            stop_loss_price=stop_loss,
            linked_id=sl_id,
        )

        # 停損單
        sl_order = SmartOrder(
            id=sl_id,
            symbol=symbol.strip().upper(),
            order_type=SmartOrderType.OCO,
            action=action,
            qty=qty,
            trigger_condition=TriggerCondition.PRICE_LTE if action == "Sell" else TriggerCondition.PRICE_GTE,
            trigger_price=stop_loss,
            take_profit_price=take_profit,
            stop_loss_price=stop_loss,
            linked_id=tp_id,
        )

        self._smart_orders.extend([tp_order, sl_order])
        self.event_bus.on_smart_order_added.emit(tp_order.to_dict())
        logger.info(f"[SmartOrder] 新增 OCO {tp_id}/{sl_id}: "
                    f"{action} {symbol} {qty}口, TP={take_profit} SL={stop_loss}")
        return tp_id

    def add_bracket(self, symbol: str, action: str, qty: int,
                    entry_price: float, take_profit: float, stop_loss: float) -> str:
        """
        新增 Bracket 單: 進場 + 自動掛停利停損
        先掛限價進場單，成交後自動掛 OCO
        """
        bracket_id = self._next_id()
        order = SmartOrder(
            id=bracket_id,
            symbol=symbol.strip().upper(),
            order_type=SmartOrderType.BRACKET,
            action=action,
            qty=qty,
            trigger_price=entry_price,
            take_profit_price=take_profit,
            stop_loss_price=stop_loss,
        )
        self._smart_orders.append(order)

        # 立即送出進場限價單
        trade = self._place_order(symbol, entry_price, action, qty)
        if trade:
            order.parent_order_id = getattr(getattr(trade, 'order', None), 'id', bracket_id)
            logger.info(f"[SmartOrder] Bracket 進場單已送出 {bracket_id}: "
                        f"{action} {symbol} {qty}口 @ {entry_price}")
        else:
            order.is_active = False
            logger.warning(f"[SmartOrder] Bracket 進場單失敗: {bracket_id}")

        self.event_bus.on_smart_order_added.emit(order.to_dict())
        return bracket_id

    # ──── 取消智慧單 ────

    def cancel(self, order_id: str) -> bool:
        """取消指定智慧單"""
        for order in self._smart_orders:
            if order.id == order_id and order.is_active:
                order.is_active = False
                # 如果是 OCO，一併取消配對單
                if order.linked_id:
                    self._cancel_linked(order.linked_id)
                logger.info(f"[SmartOrder] 已取消 {order_id}")
                return True
        return False

    def cancel_all(self, symbol: Optional[str] = None):
        """批次取消所有智慧單"""
        count = 0
        for order in self._smart_orders:
            if order.is_active:
                if symbol is None or order.symbol == symbol.strip().upper():
                    order.is_active = False
                    count += 1
        if count > 0:
            logger.info(f"[SmartOrder] 批次取消 {count} 張智慧單" +
                        (f" ({symbol})" if symbol else ""))

    def _cancel_linked(self, linked_id: str):
        for order in self._smart_orders:
            if order.id == linked_id and order.is_active:
                order.is_active = False

    # ──── 洗價檢查 (每個 tick 觸發) ────

    def _on_tick(self, symbol: str, tick_data: dict):
        """每個 tick 檢查所有該商品的智慧單"""
        price = tick_data.get("Price", 0)
        if price <= 0:
            return

        triggered = []
        for order in self._smart_orders:
            if not order.is_active or order.symbol != symbol:
                continue

            if order.order_type == SmartOrderType.MIT:
                if self._check_mit(order, price):
                    triggered.append(order)

            elif order.order_type == SmartOrderType.TRAILING_STOP:
                if self._check_trailing(order, price):
                    triggered.append(order)

            elif order.order_type == SmartOrderType.OCO:
                if self._check_mit(order, price):  # OCO 本質是兩張觸價單
                    triggered.append(order)

        # 執行觸發
        for order in triggered:
            self._execute_trigger(order, price)

    def _check_mit(self, order: SmartOrder, price: float) -> bool:
        """檢查觸價條件"""
        if order.trigger_condition == TriggerCondition.PRICE_GTE:
            return price >= order.trigger_price
        else:
            return price <= order.trigger_price

    def _check_trailing(self, order: SmartOrder, price: float) -> bool:
        """檢查移動停損"""
        if order.watermark is None:
            order.watermark = price
            return False

        if order.action == "Sell":
            # 多頭平倉: 追蹤最高價
            if price > order.watermark:
                order.watermark = price
            trigger_price = order.watermark - order.trailing_offset
            return price <= trigger_price
        else:
            # 空頭平倉: 追蹤最低價
            if price < order.watermark:
                order.watermark = price
            trigger_price = order.watermark + order.trailing_offset
            return price >= trigger_price

    def _execute_trigger(self, order: SmartOrder, trigger_price: float):
        """執行觸發: 送出市價單"""
        order.is_active = False
        order.is_triggered = True
        order.triggered_at = datetime.now().isoformat()

        logger.info(f"[SmartOrder] 觸發! {order.id} ({order.order_type.value}): "
                    f"{order.action} {order.symbol} {order.qty}口 @ 觸發價={trigger_price:.2f}")

        # 送出市價單 (price=0 表示市價)
        self._place_order(order.symbol, 0, order.action, order.qty)

        # OCO: 取消配對單
        if order.linked_id:
            self._cancel_linked(order.linked_id)

        # 發射觸發事件
        self.event_bus.on_smart_order_triggered.emit(order.to_dict())

    def _on_fill(self, fill_data: dict):
        """成交回報: 檢查 Bracket 母單是否成交"""
        for order in self._smart_orders:
            if (order.order_type == SmartOrderType.BRACKET
                    and order.is_active
                    and not order.is_triggered
                    and order.parent_order_id):
                # 母單成交 → 自動掛 OCO 停利停損
                if fill_data.get("order_id") == order.parent_order_id:
                    order.is_triggered = True
                    order.triggered_at = datetime.now().isoformat()
                    reverse_action = "Sell" if order.action == "Buy" else "Buy"
                    self.add_oco(
                        order.symbol, reverse_action, order.qty,
                        take_profit=order.take_profit_price,
                        stop_loss=order.stop_loss_price,
                    )
                    logger.info(f"[SmartOrder] Bracket 母單成交, 已自動掛 OCO: "
                                f"TP={order.take_profit_price} SL={order.stop_loss_price}")

    # ──── 查詢 ────

    def get_active_orders(self, symbol: Optional[str] = None) -> List[dict]:
        orders = [o for o in self._smart_orders if o.is_active]
        if symbol:
            orders = [o for o in orders if o.symbol == symbol.strip().upper()]
        return [o.to_dict() for o in orders]

    def get_all_orders(self) -> List[dict]:
        return [o.to_dict() for o in self._smart_orders]
