"""
SmartOrderEngine — 本地端智慧委託引擎

監聽 EventBus 的 tick 事件，對所有活躍的智慧單進行洗價檢查。
當條件滿足時，透過注入的 place_order_fn 自動送出實際委託。

支援的智慧單類型:
  - MIT (Market If Touched): 觸價單
  - TrailingStop: 移動停損
  - OCO (One Cancels Other): 停利停損二擇一
  - Bracket: 進場後自動掛停利 + 停損

執行緒模型：
  - _on_tick 在 Shioaji 行情執行緒上跑，只做條件判斷（快）；
    觸發後的實際下單透過 dispatch hook 丟到別的執行緒（backend 注入
    broker executor），不會在行情回呼裡做網路 I/O。
  - _smart_orders 以 RLock 保護（行情執行緒 + REST 執行緒並發存取）。

持久化：
  - 傳入 SmartOrderStore 時，add / cancel / 觸發都會落地，
    重啟時自動 re-arm 仍 active 的單（watermark 重新追蹤）。
"""
import logging
import threading
from enum import Enum
from typing import List, Optional, Callable
from dataclasses import dataclass, field
from datetime import datetime



logger = logging.getLogger(__name__)

#: place_order_fn 的哨兵回傳值契約：
#:   trade 物件  = 成功
#:   RISK_BLOCKED = 被風控攔下（觸發視為已消耗，不重試）
#:   None / 例外  = 下單失敗（re-arm 重試，上限 _MAX_TRIGGER_RETRIES）
RISK_BLOCKED = "RISK_BLOCKED"
_MAX_TRIGGER_RETRIES = 3


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
    parent_order_id: Optional[str] = None  # 母單 ID（可為逗號分隔的多個候選 id）
    # 狀態
    is_active: bool = True
    is_triggered: bool = False
    retry_count: int = 0                   # 觸發下單失敗的重試次數
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
            "linked_id": self.linked_id,
            "parent_order_id": self.parent_order_id,
            "is_active": self.is_active,
            "is_triggered": self.is_triggered,
            "retry_count": self.retry_count,
            "created_at": self.created_at,
            "triggered_at": self.triggered_at,
        }

    @staticmethod
    def from_dict(d: dict) -> "SmartOrder":
        return SmartOrder(
            id=str(d["id"]),
            symbol=str(d.get("symbol", "")).upper(),
            order_type=SmartOrderType(d.get("order_type", "MIT")),
            action=d.get("action", "Sell"),
            qty=int(d.get("qty", 0)),
            trigger_condition=TriggerCondition(d.get("trigger_condition", "price_lte")),
            trigger_price=float(d.get("trigger_price", 0) or 0),
            trailing_offset=float(d.get("trailing_offset", 0) or 0),
            watermark=None,  # 重啟後重新追蹤
            take_profit_price=float(d.get("take_profit_price", 0) or 0),
            stop_loss_price=float(d.get("stop_loss_price", 0) or 0),
            linked_id=d.get("linked_id"),
            parent_order_id=d.get("parent_order_id"),
            is_active=bool(d.get("is_active", True)),
            is_triggered=bool(d.get("is_triggered", False)),
            retry_count=int(d.get("retry_count", 0) or 0),
            created_at=d.get("created_at") or datetime.now().isoformat(),
            triggered_at=d.get("triggered_at"),
        )


class SmartOrderEngine:
    """
    智慧委託引擎

    使用方式:
        engine = SmartOrderEngine(event_bus, place_order_fn)
        engine.add_mit("TXFD5", "Sell", 1, trigger_price=21000, condition="price_gte")
        engine.add_trailing_stop("TXFD5", "Sell", 1, trailing_offset=20)
        engine.add_oco("TXFD5", "Sell", 1, take_profit=21100, stop_loss=20900)
    """

    def __init__(self, event_bus, place_order_fn: Callable, store=None):
        """
        Args:
            event_bus: EventBus 實例
            place_order_fn: 實際下單函數，簽名為 (symbol, price, action, qty) -> trade
            store: SmartOrderStore（None = 不持久化）
        """
        self.event_bus = event_bus
        self._place_order = place_order_fn
        self._store = store
        self._smart_orders: List[SmartOrder] = []
        self._id_counter = 0
        self._lock = threading.RLock()
        # 觸發後實際下單的派工 hook；backend 會注入 broker executor，
        # 預設 None = 同步執行（測試 / standalone 用）
        self._dispatch: Optional[Callable[[Callable], None]] = None

        # 監聽 tick 事件
        self.event_bus.on_tick.connect(self._on_tick)
        # 監聽成交事件 (用於 Bracket 單的母單成交偵測)
        self.event_bus.on_fill.connect(self._on_fill)

        # 從持久化 store re-arm 仍 active 的智慧單
        self._restore_from_store()

        logger.info("SmartOrderEngine 已初始化 (persisted=%s)",
                    bool(store and getattr(store, "enabled", False)))

    def set_dispatch(self, dispatch: Callable[[Callable], None]):
        """注入觸發下單的派工函數（例如丟進 broker thread pool）。"""
        self._dispatch = dispatch

    def _restore_from_store(self):
        if not (self._store and getattr(self._store, "enabled", False)):
            return
        restored = 0
        for d in self._store.load_active():
            try:
                order = SmartOrder.from_dict(d)
            except Exception as e:
                logger.warning(f"[SmartOrder] 無法還原智慧單 {d.get('id')}: {e}")
                continue
            if not order.is_active or order.qty <= 0:
                continue
            self._smart_orders.append(order)
            restored += 1
        # id counter 必須跳過「所有」歷史編號（含已觸發/已取消），
        # 否則重啟後新單會重用舊 id、upsert 蓋掉歷史列
        self._id_counter = self._store.max_id_seq()
        if restored:
            logger.info(f"[SmartOrder] 已從持久化還原 {restored} 張智慧單")

    def _persist(self, order: SmartOrder):
        if self._store is not None:
            self._store.save(order.to_dict())

    def _next_id(self) -> str:
        with self._lock:
            self._id_counter += 1
            return f"SMART_{self._id_counter:04d}"

    # ──── 新增智慧單 ────

    def add_mit(self, symbol: str, action: str, qty: int,
                trigger_price: float, condition: str = "price_lte") -> SmartOrder:
        """新增觸價單 (MIT)"""
        order = SmartOrder(
            id=self._next_id(),
            symbol=symbol.strip().upper(),
            order_type=SmartOrderType.MIT,
            action=action,
            qty=qty,
            trigger_condition=TriggerCondition(condition),
            trigger_price=trigger_price,
        )
        with self._lock:
            # persist 必須在 lock 內：若 append 後、persist 前就被 tick 觸發，
            # 遲到的 active 快照會把觸發後的最終狀態蓋掉
            self._smart_orders.append(order)
            self._persist(order)
        self.event_bus.on_smart_order_added.emit(order.to_dict())
        logger.info(f"[SmartOrder] 新增 MIT {order.id}: "
                    f"{action} {symbol} {qty}口 @ 觸發價{trigger_price} ({condition})")
        return order

    def add_trailing_stop(self, symbol: str, action: str, qty: int,
                          trailing_offset: float) -> SmartOrder:
        """新增移動停損"""
        order = SmartOrder(
            id=self._next_id(),
            symbol=symbol.strip().upper(),
            order_type=SmartOrderType.TRAILING_STOP,
            action=action,
            qty=qty,
            trailing_offset=trailing_offset,
        )
        with self._lock:
            self._smart_orders.append(order)
            self._persist(order)
        self.event_bus.on_smart_order_added.emit(order.to_dict())
        logger.info(f"[SmartOrder] 新增移動停損 {order.id}: "
                    f"{action} {symbol} {qty}口, 回檔={trailing_offset}點")
        return order

    def add_oco(self, symbol: str, action: str, qty: int,
                take_profit: float, stop_loss: float) -> str:
        """
        新增 OCO (One Cancels Other) 停利停損二擇一
        """
        tp_id = self._next_id()
        sl_id = self._next_id()
        sym = symbol.strip().upper()

        # 停利單：多單平倉(Sell)在價格 >= TP 時觸發；空單回補(Buy)在價格 <= TP
        tp_cond = TriggerCondition.PRICE_GTE if action == "Sell" else TriggerCondition.PRICE_LTE
        # 停損單：方向相反
        sl_cond = TriggerCondition.PRICE_LTE if action == "Sell" else TriggerCondition.PRICE_GTE

        tp_order = SmartOrder(
            id=tp_id, symbol=sym, order_type=SmartOrderType.OCO,
            action=action, qty=qty,
            trigger_condition=tp_cond, trigger_price=take_profit,
            take_profit_price=take_profit, stop_loss_price=stop_loss,
            linked_id=sl_id,
        )
        sl_order = SmartOrder(
            id=sl_id, symbol=sym, order_type=SmartOrderType.OCO,
            action=action, qty=qty,
            trigger_condition=sl_cond, trigger_price=stop_loss,
            take_profit_price=take_profit, stop_loss_price=stop_loss,
            linked_id=tp_id,
        )
        with self._lock:
            self._smart_orders.append(tp_order)
            self._smart_orders.append(sl_order)
            self._persist(tp_order)
            self._persist(sl_order)
        self.event_bus.on_smart_order_added.emit(sl_order.to_dict())
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
        with self._lock:
            self._smart_orders.append(order)
            self._persist(order)

        # 立即送出進場限價單
        trade = self._place_order(symbol, entry_price, action, qty)
        if trade and trade != RISK_BLOCKED:
            # 母單 id 收集所有候選（id / seqno / ordno）——
            # 成交回報帶的是 ordno/seqno，不一定等於 order.id
            broker_order = getattr(trade, 'order', None)
            candidates = []
            for attr in ("id", "seqno", "ordno"):
                v = getattr(broker_order, attr, None)
                if v:
                    candidates.append(str(v))
            order.parent_order_id = ",".join(dict.fromkeys(candidates)) or bracket_id
            logger.info(f"[SmartOrder] Bracket 進場單已送出 {bracket_id}: "
                        f"{action} {symbol} {qty}口 @ {entry_price}")
        else:
            order.is_active = False
            logger.warning(f"[SmartOrder] Bracket 進場單失敗: {bracket_id}")

        self._persist(order)
        self.event_bus.on_smart_order_added.emit(order.to_dict())
        return bracket_id

    # ──── 取消智慧單 ────

    def cancel(self, order_id: str) -> bool:
        """取消指定智慧單"""
        with self._lock:
            for order in self._smart_orders:
                if order.id == order_id and order.is_active:
                    order.is_active = False
                    self._persist(order)
                    # 如果是 OCO，一併取消配對單
                    if order.linked_id:
                        self._cancel_linked(order.linked_id)
                    logger.info(f"[SmartOrder] 已取消 {order_id}")
                    return True
        return False

    def cancel_all(self, symbol: Optional[str] = None) -> int:
        """批次取消所有智慧單，回傳取消數量。"""
        count = 0
        with self._lock:
            for order in self._smart_orders:
                if order.is_active:
                    if symbol is None or order.symbol == symbol.strip().upper():
                        order.is_active = False
                        self._persist(order)
                        count += 1
        if count > 0:
            logger.info(f"[SmartOrder] 批次取消 {count} 張智慧單" +
                        (f" ({symbol})" if symbol else ""))
        return count

    def _cancel_linked(self, linked_id: str):
        """REST cancel 路徑用：標記 + 立即持久化（非行情執行緒，inline 寫檔 OK）"""
        with self._lock:
            for order in self._deactivate_linked_nolock(linked_id):
                self._persist(order)

    def _deactivate_linked_nolock(self, linked_id: str) -> List["SmartOrder"]:
        """觸發路徑用：僅標記（呼叫者已持鎖），持久化延後到 dispatch。"""
        out = []
        for order in self._smart_orders:
            if order.id == linked_id and order.is_active:
                order.is_active = False
                out.append(order)
        return out

    # ──── 洗價檢查 (每個 tick 觸發) ────

    def _on_tick(self, symbol: str, tick_data: dict):
        """每個 tick 檢查所有該商品的智慧單（在行情執行緒上，只做判斷）"""
        price = tick_data.get("Price", 0)
        if price <= 0:
            return

        triggered = []
        linked_by_order: dict = {}
        with self._lock:
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

            # 在 lock 內先標記為非 active，確保同一張單不會被下一個 tick 重複觸發；
            # SQLite 寫檔不在 lock 內、也不在行情執行緒上做。
            # 每張觸發單記住「自己取消掉的配對腿」—— 下單失敗 re-arm 時
            # 配對腿必須一起復活，否則 OCO 變成單邊保護
            for order in triggered:
                order.is_active = False
                order.is_triggered = True
                order.triggered_at = datetime.now().isoformat()
                if order.linked_id:
                    linked_by_order[order.id] = self._deactivate_linked_nolock(order.linked_id)

        # 實際下單在 lock 外執行（並透過 dispatch 離開行情執行緒）
        for order in triggered:
            self._execute_trigger(order, price, linked_by_order.get(order.id, []))

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

    def _execute_trigger(self, order: SmartOrder, trigger_price: float,
                         linked_legs: Optional[List["SmartOrder"]] = None):
        """
        執行觸發: 送出市價單（下單 I/O 透過 dispatch 離開行情執行緒）。

        持久化時序：在「下單有結果之後」才落地最終狀態 ——
        若在送單前就把 DB 標成已消耗，process 在送單前當機會讓停損無聲消失；
        反過來（送單成功但落地前當機）重啟會 re-arm 重送一次保護單，
        方向上寧可重複保護、不可丟失保護。

        linked_legs：本次觸發連帶取消的 OCO 配對腿。成功/被攔下時一併落地；
        下單「失敗」re-arm 時必須一起復活，否則 OCO 從此變成單邊保護。
        """
        legs = linked_legs or []
        logger.info(f"[SmartOrder] 觸發! {order.id} ({order.order_type.value}): "
                    f"{order.action} {order.symbol} {order.qty}口 @ 觸發價={trigger_price:.2f}")

        def _send():
            try:
                # 送出市價單 (price=0 表示市價)
                result = self._place_order(order.symbol, 0, order.action, order.qty)
            except Exception as e:
                logger.error(f"[SmartOrder] 觸發下單例外 {order.id}: {e}", exc_info=True)
                result = None

            # RISK_BLOCKED 是 truthy 字串 —— result 為任何非 None/非空值
            # 都代表「已消耗」（成功送出，或被風控攔下不重試）
            if result:
                self._persist(order)
                for leg in legs:
                    self._persist(leg)
                return

            # 下單失敗 → re-arm 重試（上限 _MAX_TRIGGER_RETRIES）
            rearmed_legs: List[SmartOrder] = []
            with self._lock:
                order.retry_count += 1
                if order.retry_count >= _MAX_TRIGGER_RETRIES:
                    self._persist(order)
                    # 放棄重試：復活配對腿，至少保住另一邊的保護
                    for leg in legs:
                        leg.is_active = True
                        self._persist(leg)
                        rearmed_legs.append(leg)
                    logger.error(f"[SmartOrder] {order.id} 觸發下單連續失敗 "
                                 f"{order.retry_count} 次，放棄重試")
                    try:
                        self.event_bus.on_error.emit(
                            "critical",
                            f"智慧單 {order.id} 觸發下單失敗且已達重試上限，保護單未成交！")
                    except Exception:
                        pass
                else:
                    order.is_active = True
                    order.is_triggered = False
                    order.triggered_at = None
                    order.watermark = None
                    self._persist(order)
                    # 配對腿一起復活（下一次觸發會再取消一次）
                    for leg in legs:
                        leg.is_active = True
                        self._persist(leg)
                        rearmed_legs.append(leg)
                    logger.warning(f"[SmartOrder] {order.id} 觸發下單失敗，已 re-arm "
                                   f"(重試 {order.retry_count}/{_MAX_TRIGGER_RETRIES})")
            if order.is_active:
                self.event_bus.on_smart_order_added.emit(order.to_dict())
            for leg in rearmed_legs:
                self.event_bus.on_smart_order_added.emit(leg.to_dict())

        if self._dispatch is not None:
            self._dispatch(_send)
        else:
            _send()

        # 發射觸發事件
        self.event_bus.on_smart_order_triggered.emit(order.to_dict())

    def _on_fill(self, fill_data: dict):
        """成交回報: 檢查 Bracket 母單是否成交"""
        fill_id = str(fill_data.get("order_id") or "")
        if not fill_id:
            return
        matched = []
        with self._lock:
            for order in self._smart_orders:
                if (order.order_type == SmartOrderType.BRACKET
                        and order.is_active
                        and not order.is_triggered
                        and order.parent_order_id):
                    # 母單成交 → 自動掛 OCO 停利停損。
                    # parent_order_id 可能是多個候選（id/seqno/ordno）逗號分隔
                    if fill_id in order.parent_order_id.split(","):
                        order.is_triggered = True
                        order.triggered_at = datetime.now().isoformat()
                        matched.append(order)
        for order in matched:
            self._persist(order)
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
        with self._lock:
            orders = [o for o in self._smart_orders if o.is_active]
            if symbol:
                orders = [o for o in orders if o.symbol == symbol.strip().upper()]
            return [o.to_dict() for o in orders]

    def get_all_orders(self) -> List[dict]:
        with self._lock:
            return [o.to_dict() for o in self._smart_orders]
