"""
SmartOrderEngine — 本地端智慧委託引擎

監聽 EventBus 的 tick 事件，對所有活躍的智慧單進行洗價檢查。
當條件滿足時，透過注入的 place_order_fn 自動送出實際委託。

支援的智慧單類型:
  - MIT (Market If Touched): 觸價單
  - TrailingStop: 移動停損
  - OCO (One Cancels Other): 停利停損二擇一
  - Bracket: 進場後自動掛停利 + 停損
  - CHASE: 追價智慧單（掛最佳對手價，對手價不利移動時 cancel-replace 追價）

執行緒模型：
  - _on_tick / _on_bidask 在 Shioaji 行情執行緒上跑，只做條件判斷（快）；
    觸發後的實際下單/撤單透過 dispatch hook 丟到別的執行緒（backend 注入
    order executor），不會在行情回呼裡做網路 I/O。
  - _smart_orders 以 RLock 保護（行情執行緒 + REST 執行緒並發存取）。

持久化：
  - 傳入 SmartOrderStore 時，add / cancel / 觸發都會落地，
    重啟時自動 re-arm 仍 active 的單（watermark 重新追蹤）。
  - CHASE 單重啟後標記為「待 re-attach」：第一輪 sync_broker_orders
    對帳能對上 working order 就續追，對不上就標終態，不留殭屍。
"""
import logging
import threading
import time
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
#: place_order_fn 的暫態哨兵：被「頻率限制」這類暫態風控 BLOCK 擋下。
#: 與 RISK_BLOCKED（真正的風控封鎖，終態）不同 —— RATE_LIMITED 不終結
#: 整張 CHASE，本次動作放棄、下輪重試。
RATE_LIMITED = "RATE_LIMITED"
_MAX_TRIGGER_RETRIES = 3

#: 券商端仍算「活躍」的委託狀態（與 order_sync.ACTIVE_STATUSES 對齊）
_BROKER_ACTIVE_STATUSES = {"PendingSubmit", "PreSubmitted", "Submitted", "PartFilled"}


class SmartOrderType(Enum):
    MIT = "MIT"                    # Market If Touched (觸價單)
    TRAILING_STOP = "TrailingStop" # 移動停損
    OCO = "OCO"                    # One Cancels Other
    BRACKET = "Bracket"            # 進場後自動掛停利停損
    CHASE = "CHASE"                # 追價智慧單


class ChaseStatus:
    """CHASE 狀態機（chase_status 欄位值）

    CHASING ──不利移動 ≥ reprice_ticks 且距上次改價 ≥ interval──▶ CHASING（reprice_count+1）
    CHASING ──全部成交──────────────────────────▶ FILLED
    CHASING ──新掛價距初始掛價 > max_chase_ticks，final=GIVE_UP──▶ GAVE_UP（撤單）
    CHASING ──新掛價距初始掛價 > max_chase_ticks，final=MARKET──▶ COMPLETED（撤單+剩量市價）
    CHASING ──使用者取消────────────────────────▶ CANCELLED（撤掛單）
    CHASING ──掛單消失/被撤且非我方動作──────────▶ CANCELLED_EXTERNAL
    CHASING ──改價/轉市價被風控攔───────────────▶ RISK_BLOCKED
    （進場/改價下單失敗 → FAILED）
    重啟 re-attach 對不上 working orders → CANCELLED_EXTERNAL
    """
    CHASING = "CHASING"
    FILLED = "FILLED"
    GAVE_UP = "GAVE_UP"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    CANCELLED_EXTERNAL = "CANCELLED_EXTERNAL"
    RISK_BLOCKED = "RISK_BLOCKED"
    FAILED = "FAILED"

    TERMINAL = {FILLED, GAVE_UP, COMPLETED, CANCELLED,
                CANCELLED_EXTERNAL, RISK_BLOCKED, FAILED}


def default_tick_size(price: float, symbol: str) -> float:
    """未注入 tick_size_fn 時的保底（backend 會注入 contract_specs.get_tick_size，
    兩者邏輯一致；這份 fallback 讓 core 可獨立運作、不反向依賴 backend）。"""
    sym = (symbol or "").upper()
    p = float(price or 0)
    # ── 選擇權（TXO 台指選擇權 / TFO 個股選擇權）：權利金級距 ──
    #   ★ 必須在 TX/TF 前綴判斷之前，否則 "TXO" 被 "TX" 吞成 1.0，
    #     權利金 5 點的選擇權用 1.0 級距，chase 追一格就跳 20% → 永遠追不上。
    if sym.startswith(("TXO", "TFO")):
        if p < 10: return 0.1
        if p < 50: return 0.5
        if p < 500: return 1.0
        if p < 1000: return 5.0
        return 10.0
    # ── 電子期(EXF) / 櫃買期(GTF)：0.05 點（之前誤設 1.0，chase 追不上） ──
    if sym.startswith(("EXF", "GTF")):
        return 0.05
    # ── 金融期(FXF)：0.2 點 ──
    if sym.startswith(("FXF",)):
        return 0.2
    # ── 股價指數期貨（大台/小台/微型）：1 點 ──
    if sym.startswith(("TXF", "MXF", "TX", "MX", "UD", "MYM")):
        return 1.0
    if sym.startswith(("NQ", "MNQ", "ES", "MES")):
        return 0.25
    # ── 台灣 ETF（00 開頭，如 0050/006208）：0.01 / 0.05，與個股不同 ──
    if sym.startswith("00"):
        return 0.01 if p < 50 else 0.05
    if p < 10: return 0.01
    if p < 50: return 0.05
    if p < 100: return 0.10
    if p < 500: return 0.50
    if p < 1000: return 1.00
    if p >= 10000: return 1.00
    return 5.00


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
    # CHASE 專用（契約欄位名，不可改）
    max_chase_ticks: int = 10          # 相對「初始掛價」最大追價距離（tick 數）
    reprice_ticks: int = 1             # 落後最佳對手價 ≥ 此 tick 數才改價
    reprice_interval_ms: int = 1500    # 兩次改價之間最小間隔
    final_action: str = "GIVE_UP"      # 追到上限後：GIVE_UP=撤單 / MARKET=剩量轉市價
    # CHASE 狀態
    chase_status: Optional[str] = None    # ChaseStatus.*（非 CHASE 單為 None）
    initial_price: float = 0.0            # 初始掛價（max_chase_ticks 的基準）
    chase_price: float = 0.0              # 目前掛價
    reprice_count: int = 0                # 已改價次數
    filled_qty: int = 0                   # 已成交量（剩量 = qty - filled_qty）
    broker_order_ids: str = ""            # 目前 working order 的候選 id/seqno/ordno（逗號分隔）
    # 狀態
    is_active: bool = True
    is_triggered: bool = False
    retry_count: int = 0                   # 觸發下單失敗的重試次數
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    triggered_at: Optional[str] = None

    @property
    def remaining_qty(self) -> int:
        return max(self.qty - self.filled_qty, 0)

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
            "max_chase_ticks": self.max_chase_ticks,
            "reprice_ticks": self.reprice_ticks,
            "reprice_interval_ms": self.reprice_interval_ms,
            "final_action": self.final_action,
            "chase_status": self.chase_status,
            "initial_price": self.initial_price,
            "chase_price": self.chase_price,
            "reprice_count": self.reprice_count,
            "filled_qty": self.filled_qty,
            "remaining_qty": self.remaining_qty,
            "broker_order_ids": self.broker_order_ids,
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
            max_chase_ticks=int(d.get("max_chase_ticks", 10) or 10),
            reprice_ticks=int(d.get("reprice_ticks", 1) or 1),
            reprice_interval_ms=int(d.get("reprice_interval_ms", 1500) or 1500),
            final_action=str(d.get("final_action") or "GIVE_UP"),
            chase_status=d.get("chase_status"),
            initial_price=float(d.get("initial_price", 0) or 0),
            chase_price=float(d.get("chase_price", 0) or 0),
            reprice_count=int(d.get("reprice_count", 0) or 0),
            filled_qty=int(d.get("filled_qty", 0) or 0),
            broker_order_ids=str(d.get("broker_order_ids") or ""),
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

    def __init__(self, event_bus, place_order_fn: Callable, store=None,
                 cancel_order_fn: Optional[Callable] = None,
                 tick_size_fn: Optional[Callable] = None):
        """
        Args:
            event_bus: EventBus 實例
            place_order_fn: 實際下單函數，簽名為 (symbol, price, action, qty) -> trade
            store: SmartOrderStore（None = 不持久化）
            cancel_order_fn: 撤單函數（CHASE cancel-replace 用），
                             簽名 (order_ids: list[str]) -> bool
            tick_size_fn: tick 級距函數 (price, symbol) -> float；
                          None 時用 default_tick_size（backend 注入 contract_specs 版）
        """
        self.event_bus = event_bus
        self._place_order = place_order_fn
        self._cancel_order = cancel_order_fn
        #: 撤單終態確認函數（P0-1）：(order_ids: list[str]) -> dict | None
        #:   回 {"cancelled": bool, "filled_qty": int}（該單累計成交量），
        #:   None = 無法確認（逾時 / 例外）。未注入時退回舊行為（信任 remaining）。
        self._confirm_cancel = None
        self._tick_size = tick_size_fn or default_tick_size
        self._store = store
        self._smart_orders: List[SmartOrder] = []
        self._id_counter = 0
        self._lock = threading.RLock()
        # 觸發後實際下單的派工 hook；backend 會注入 broker executor，
        # 預設 None = 同步執行（測試 / standalone 用）
        self._dispatch: Optional[Callable[[Callable], None]] = None

        # ── CHASE 執行期狀態（不持久化） ──
        self._now_ms: Callable[[], float] = lambda: time.monotonic() * 1000.0
        self._best_quotes: dict = {}            # symbol -> (bid1, ask1)
        self._last_prices: dict = {}            # symbol -> 最新成交價
        self._chase_busy: set = set()           # 改價/收尾進行中的 chase id（避免重入）
        self._chase_runtime: dict = {}          # id -> {last_reprice_ms, last_place_ms}
        self._chase_reattach_pending: set = set()  # 重啟後等第一輪對帳 re-attach 的 chase id
        self._chase_fill_seen: dict = {}        # id -> 已入帳的 fill id（去重）
        self._chase_all_ids: dict = {}          # id -> 歷來所有 broker 單號（改價前的舊單成交也要對得上）
        # 每個 chase 的「腿」：每次進場/改價各一腿。每腿記自己的 broker 單號與
        # 已成量；order.filled_qty = Σ 各腿已成量（P1-2：跨腿漏帳修正）。
        self._chase_legs: dict = {}             # id -> [{"ids": set, "filled": int}, ...]
        # 完整快照中「連續看不到該單」的輪數；達 _external_cancel_rounds 才判外部撤單（P1-4）
        self._chase_missing_rounds: dict = {}   # id -> int
        self._external_cancel_rounds = 2        # 需連續 N 輪完整快照缺席才判死
        # 掛單消失視為外部撤單前的寬限期：剛送出的單在下一輪對帳快照裡
        # 可能還沒出現（快照先拉、下單後至），寬限期內不誤判
        self._external_cancel_grace_ms = 10_000.0

        # 監聽 tick 事件
        self.event_bus.on_tick.connect(self._on_tick)
        # 監聽五檔事件（CHASE 追最佳對手價）；舊 EventBus 沒有此 signal 時跳過
        bidask_sig = getattr(self.event_bus, "on_bidask", None)
        if bidask_sig is not None:
            bidask_sig.connect(self._on_bidask)
        # 監聽成交事件 (用於 Bracket 單的母單成交偵測 / CHASE 成交追蹤)
        self.event_bus.on_fill.connect(self._on_fill)

        # 從持久化 store re-arm 仍 active 的智慧單
        self._restore_from_store()

        logger.info("SmartOrderEngine 已初始化 (persisted=%s)",
                    bool(store and getattr(store, "enabled", False)))

    def set_dispatch(self, dispatch: Callable[[Callable], None]):
        """注入觸發下單的派工函數（例如丟進 broker thread pool）。"""
        self._dispatch = dispatch

    def set_chase_helpers(self, cancel_order_fn: Optional[Callable] = None,
                          tick_size_fn: Optional[Callable] = None,
                          confirm_cancel_fn: Optional[Callable] = None):
        """注入 CHASE 需要的撤單 / tick 級距 / 撤單確認函數（backend 開機時呼叫）。"""
        if cancel_order_fn is not None:
            self._cancel_order = cancel_order_fn
        if tick_size_fn is not None:
            self._tick_size = tick_size_fn
        if confirm_cancel_fn is not None:
            self._confirm_cancel = confirm_cancel_fn

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
            if order.order_type == SmartOrderType.CHASE:
                # 重啟後不知道掛單是否還在：標記待 re-attach，
                # 第一輪 sync_broker_orders 對上 → 續追；對不上 → 標終態
                self._chase_reattach_pending.add(order.id)
                ids = set(x for x in (order.broker_order_ids or "").split(",") if x)
                self._chase_all_ids[order.id] = set(ids)
                # 還原成單一腿（已成量 = 落地的 filled_qty），續追以此為基準
                self._chase_legs[order.id] = (
                    [{"ids": ids, "filled": int(order.filled_qty or 0)}] if ids else [])
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

    def add_chase(self, symbol: str, action: str, qty: int,
                  max_chase_ticks: int = 10, reprice_ticks: int = 1,
                  reprice_interval_ms: int = 1500,
                  final_action: str = "GIVE_UP") -> Optional[SmartOrder]:
        """
        新增 CHASE 追價單：立即以限價掛在最佳對手價
        （Buy→ask1 / Sell→bid1；取不到五檔時用最新成交價）。

        回傳：
          - None：取不到任何報價，無法定價（不建單）
          - SmartOrder：chase_status = CHASING（進場成功）/
            RISK_BLOCKED（進場被風控攔下）/ FAILED（進場下單失敗），
            後兩者為終態、is_active=False
        """
        sym = symbol.strip().upper()
        entry = self._best_opposite_price(sym, action)
        if entry is None or entry <= 0:
            logger.warning(f"[SmartOrder] CHASE 建立失敗：{sym} 取不到報價")
            return None
        tick = self._tick_size_of(entry, sym)
        entry = self._snap_to_tick(entry, tick)

        order = SmartOrder(
            id=self._next_id(),
            symbol=sym,
            order_type=SmartOrderType.CHASE,
            action=action,
            qty=qty,
            max_chase_ticks=int(max_chase_ticks),
            reprice_ticks=int(reprice_ticks),
            reprice_interval_ms=int(reprice_interval_ms),
            final_action=str(final_action or "GIVE_UP").upper(),
            chase_status=ChaseStatus.CHASING,
            initial_price=entry,
            chase_price=entry,
        )

        # #5：先在鎖內註冊（進 _smart_orders + 建 runtime/腿/all_ids）再送單，
        # 讓「進場立即成交」的回報有單可對；送單期間先佔 _chase_busy，
        # 避免行情執行緒在 broker_order_ids 尚未回填前就對這張單排改價（否則
        # 會在進場單仍在途時另掛一腿 → 超量）。
        with self._lock:
            self._smart_orders.append(order)
            self._chase_runtime[order.id] = {
                "last_reprice_ms": None,           # 尚未改過價 → 第一次改價不受 interval 限制
                "last_place_ms": self._now_ms(),
            }
            self._chase_legs[order.id] = []
            self._chase_all_ids[order.id] = set()
            self._chase_busy.add(order.id)

        # 進場：走注入的統一下單路徑（order_guard.smart_place_order —— 風控 /
        # RISK_BLOCKED 處理比照 MIT 觸發）。add_chase 由 REST 在 broker 執行緒
        # 上呼叫，同步阻塞 OK。_safe_place 內部已吞例外（回 None），不會拋出；
        # 仍以 finally 保證 busy 一定被清掉。
        result = None
        try:
            result = self._safe_place(sym, entry, action, qty)
        finally:
            with self._lock:
                if result == RISK_BLOCKED:
                    order.is_active = False
                    order.chase_status = ChaseStatus.RISK_BLOCKED
                    self._chase_runtime.pop(order.id, None)
                    logger.warning(f"[SmartOrder] CHASE {order.id} 進場被風控攔下")
                elif result:
                    ids = self._trade_id_candidates(result)
                    order.broker_order_ids = ",".join(ids)
                    self._chase_all_ids[order.id].update(ids)
                    self._add_leg_nolock(order, ids)
                    logger.info(f"[SmartOrder] 新增 CHASE {order.id}: {action} {sym} {qty}口 "
                                f"@ {entry}（max={max_chase_ticks}t, reprice≥{reprice_ticks}t, "
                                f"interval={reprice_interval_ms}ms, final={order.final_action}）")
                else:
                    order.is_active = False
                    order.chase_status = ChaseStatus.FAILED
                    self._chase_runtime.pop(order.id, None)
                    logger.warning(f"[SmartOrder] CHASE {order.id} 進場下單失敗")
                self._chase_busy.discard(order.id)
                # 最終狀態落地（不在送單前先 persist，避免送單前當機留下無單號殭屍）
                self._persist(order)
        self.event_bus.on_smart_order_added.emit(order.to_dict())
        return order

    # ──── CHASE：報價監看 / 改價 / 收尾 ────

    def _tick_size_of(self, price: float, symbol: str) -> float:
        try:
            t = float(self._tick_size(price, symbol))
            return t if t > 0 else 1.0
        except Exception:
            return 1.0

    @staticmethod
    def _snap_to_tick(price: float, tick: float) -> float:
        """把價格貼齊 tick 網格（round 掉浮點屑）。"""
        if tick <= 0:
            return price
        return round(round(price / tick) * tick, 4)

    def _best_opposite_price(self, symbol: str, action: str) -> Optional[float]:
        """最佳對手價：Buy→ask1、Sell→bid1；取不到五檔時退回最新成交價。"""
        quotes = self._best_quotes.get(symbol)
        if quotes:
            bid1, ask1 = quotes
            px = ask1 if action == "Buy" else bid1
            if px and px > 0:
                return float(px)
        last = self._last_prices.get(symbol)
        return float(last) if last and last > 0 else None

    def _safe_place(self, symbol: str, price: float, action: str, qty: int):
        try:
            return self._place_order(symbol, price, action, qty)
        except Exception as e:
            logger.error(f"[SmartOrder] 下單例外 {symbol} {action} {qty}@{price}: {e}",
                         exc_info=True)
            return None

    @staticmethod
    def _trade_id_candidates(trade) -> List[str]:
        """從 trade 物件收集所有可能的委託單號（id/seqno/ordno）。"""
        broker_order = getattr(trade, "order", None)
        out = []
        for attr in ("id", "seqno", "ordno"):
            v = getattr(broker_order, attr, None)
            if v:
                out.append(str(v))
        return list(dict.fromkeys(out))

    def _dispatch_task(self, fn: Callable):
        """把 broker I/O 丟出行情執行緒（無 dispatch 時同步執行 — 測試用）。"""
        if self._dispatch is not None:
            self._dispatch(fn)
        else:
            fn()

    # ──── CHASE 腿（leg）記帳：filled_qty = Σ 各腿已成量（P1-2） ────

    def _add_leg_nolock(self, order: SmartOrder, ids) -> None:
        """為 chase 新增一腿（進場 / 每次改價各一腿）。呼叫者持鎖。"""
        legs = self._chase_legs.setdefault(order.id, [])
        legs.append({"ids": set(str(i) for i in ids if i), "filled": 0})

    def _recompute_filled_nolock(self, order: SmartOrder) -> None:
        """order.filled_qty = Σ 各腿已成量（去重，跨腿累加）。呼叫者持鎖。"""
        legs = self._chase_legs.get(order.id)
        if legs is None:
            return
        order.filled_qty = min(order.qty, sum(int(l["filled"]) for l in legs))

    def _leg_for_id_nolock(self, order: SmartOrder, match_id: str) -> Optional[dict]:
        for leg in self._chase_legs.get(order.id, []):
            if match_id in leg["ids"]:
                return leg
        return None

    def _apply_leg_cumulative_nolock(self, order: SmartOrder, entry_ids: set,
                                     cumulative) -> bool:
        """對帳/撤單確認路徑：以「該腿的券商累計成交量」更新該腿（取 max，
        不跨腿比較 → 修正 P1-2）；並把對到的所有識別碼回填該腿（P1-3）。
        呼叫者持鎖。回傳是否對到腿。"""
        match = None
        for leg in self._chase_legs.get(order.id, []):
            if leg["ids"] & entry_ids:
                match = leg
                break
        if match is None:
            return False
        match["ids"] |= entry_ids                       # P1-3：回填真 ordno 等識別碼
        self._chase_all_ids.setdefault(order.id, set()).update(entry_ids)
        if cumulative is not None:
            try:
                match["filled"] = max(int(match["filled"]),
                                      min(int(cumulative), order.qty))
            except (TypeError, ValueError):
                pass
        self._recompute_filled_nolock(order)
        return True

    def _emit_update(self, order: SmartOrder):
        """廣播智慧單狀態變更（SmartOrderUpdate：含目前掛價/改價次數/剩量）。"""
        sig = getattr(self.event_bus, "on_smart_order_updated", None) \
            or self.event_bus.on_smart_order_added
        try:
            sig.emit(order.to_dict())
        except Exception:
            pass

    def _on_bidask(self, symbol: str, bidask_data: dict):
        """五檔回呼（行情執行緒）：快取最佳買賣價，然後檢查追價條件。"""
        try:
            bids = bidask_data.get("BidPrice") or bidask_data.get("bid_price") or []
            asks = bidask_data.get("AskPrice") or bidask_data.get("ask_price") or []
            bid1 = float(bids[0]) if bids else 0.0
            ask1 = float(asks[0]) if asks else 0.0
        except (TypeError, ValueError, IndexError):
            return
        if bid1 <= 0 and ask1 <= 0:
            return
        self._best_quotes[symbol] = (bid1, ask1)
        self._check_chase_orders(symbol)

    def _check_chase_orders(self, symbol: str):
        """行情執行緒上的追價檢查：只做判斷，broker I/O 丟 dispatch。"""
        now = self._now_ms()
        to_reprice: List[tuple] = []
        to_finalize: List[SmartOrder] = []
        with self._lock:
            for order in self._smart_orders:
                if (order.order_type != SmartOrderType.CHASE
                        or not order.is_active
                        or order.symbol != symbol
                        or order.chase_status != ChaseStatus.CHASING
                        or order.id in self._chase_busy
                        or order.id in self._chase_reattach_pending):
                    continue
                target = self._best_opposite_price(symbol, order.action)
                if target is None or target <= 0:
                    continue
                tick = self._tick_size_of(target, symbol)
                target = self._snap_to_tick(target, tick)
                # 不利移動幅度（Buy：對手價上漲；Sell：對手價下跌）
                adverse = (target - order.chase_price) if order.action == "Buy" \
                    else (order.chase_price - target)
                if adverse < tick * order.reprice_ticks - 1e-9:
                    continue
                # 改價節流：距上次改價 < reprice_interval_ms 不動作
                rt = self._chase_runtime.get(order.id) or {}
                last = rt.get("last_reprice_ms")
                if last is not None and (now - last) < order.reprice_interval_ms:
                    continue
                # 追價上限：新掛價與「初始掛價」距離超過 max_chase_ticks →
                # 停止追價，執行 final_action
                dist_ticks = round(abs(target - order.initial_price) / tick)
                self._chase_busy.add(order.id)
                if dist_ticks > order.max_chase_ticks:
                    to_finalize.append(order)
                else:
                    self._chase_runtime.setdefault(order.id, {})["last_reprice_ms"] = now
                    to_reprice.append((order, target))
        for order, price in to_reprice:
            self._dispatch_task(lambda o=order, p=price: self._reprice_chase(o, p))
        for order in to_finalize:
            self._dispatch_task(lambda o=order: self._finalize_chase(o))

    def _cancel_broker_order(self, order: SmartOrder) -> bool:
        """撤掉 chase 目前的 working order（在 order executor 上執行）。"""
        if self._cancel_order is None:
            logger.warning(f"[SmartOrder] CHASE {order.id} 無 cancel_order_fn，無法撤單")
            return False
        ids = [x for x in (order.broker_order_ids or "").split(",") if x]
        if not ids:
            return True  # 沒有掛單可撤（視為已撤）
        try:
            return bool(self._cancel_order(ids))
        except Exception as e:
            logger.error(f"[SmartOrder] CHASE {order.id} 撤單例外: {e}", exc_info=True)
            return False

    def _confirm_and_settle_cancel(self, order: SmartOrder) -> Optional[bool]:
        """P0-1：撤單後確認終態並回填該腿實際成交量。

        回傳：
          True  = 已確認撤單終態（掛單已離開活躍集合）→ 可安全以實際剩量掛新單
          False = 撤單未確認 / 逾時 → 本輪放棄（保留舊單，下輪再試）
          None  = 未注入 confirm_cancel_fn → 退回舊行為（信任 remaining_qty）

        撤單未確認前不得送新單：真 SDK 撤單非同步，舊單可能在撤單在途時
        於交易所端部分成交，若此時盲送剩量新腿會超量建倉。
        """
        if self._confirm_cancel is None:
            return None
        ids = [x for x in (order.broker_order_ids or "").split(",") if x]
        if not ids:
            return True  # 沒有 working 單可撤（視為已離開活躍集合）
        try:
            info = self._confirm_cancel(ids)
        except Exception as e:
            logger.error(f"[SmartOrder] CHASE {order.id} 撤單確認例外: {e}", exc_info=True)
            return False
        if not info:
            return False
        with self._lock:
            self._apply_leg_cumulative_nolock(
                order, set(str(i) for i in ids), info.get("filled_qty"))
        return bool(info.get("cancelled"))

    def _chase_terminal(self, order: SmartOrder, status: str):
        """標記 chase 終態 + 落地 + 廣播。"""
        with self._lock:
            order.chase_status = status
            order.is_active = False
            self._chase_runtime.pop(order.id, None)
            self._chase_reattach_pending.discard(order.id)
        self._persist(order)
        self._emit_update(order)
        logger.info(f"[SmartOrder] CHASE {order.id} → {status} "
                    f"(filled {order.filled_qty}/{order.qty}, "
                    f"repriced {order.reprice_count}次)")

    def _reprice_chase(self, order: SmartOrder, new_price: float):
        """改價（order executor）：cancel-replace 到新的最佳對手價，數量=剩量。

        P0-1 不變量：活躍掛單量 + 已成量 ≤ qty。撤單 → 確認撤單終態 + 回填實際
        成交 → 以 (qty - 實際已成) 為剩量 → 再掛新單。撤單未確認前不送新單。
        """
        try:
            if not order.is_active or order.chase_status != ChaseStatus.CHASING:
                return
            has_working = bool([x for x in (order.broker_order_ids or "").split(",") if x])
            if has_working:
                if not self._cancel_broker_order(order):
                    # 撤單失敗（可能剛好全成/已被撤）→ 這輪放棄，
                    # 成交/對帳路徑會把最終狀態補上
                    logger.warning(f"[SmartOrder] CHASE {order.id} 改價前撤單失敗，略過本輪")
                    return
                confirmed = self._confirm_and_settle_cancel(order)
                if confirmed is False:
                    # 撤單未確認終態 → 不得送新單（否則舊單在途成交會超量）。
                    # 保留舊單，下輪再試。
                    logger.warning(f"[SmartOrder] CHASE {order.id} 撤單未確認，"
                                   f"保留舊單、本輪不改價")
                    return
            # #6：撤舊單後、送新單前二次驗證 —— 期間可能被使用者取消 → 不掛新單
            with self._lock:
                if not order.is_active or order.chase_status != ChaseStatus.CHASING:
                    return
                remaining = order.remaining_qty
            if remaining <= 0:
                self._chase_terminal(order, ChaseStatus.FILLED)
                return
            result = self._safe_place(order.symbol, new_price, order.action, remaining)
            if result == RATE_LIMITED:
                # #8：暫態頻率限制，不終結整張 chase。舊腿已撤、尚無新 working 單 →
                # 清空單號，下輪 _check_chase_orders 觸發時直接重掛（不再重撤）。
                with self._lock:
                    order.broker_order_ids = ""
                logger.warning(f"[SmartOrder] CHASE {order.id} 改價遇頻率限制，"
                               f"本輪放棄、下輪重試")
                return
            if result == RISK_BLOCKED:
                # 舊單已撤、新單被風控攔 → 終態（比照 MIT 觸發被攔：已消耗不重試）
                self._chase_terminal(order, ChaseStatus.RISK_BLOCKED)
                return
            if not result:
                self._chase_terminal(order, ChaseStatus.FAILED)
                try:
                    self.event_bus.on_error.emit(
                        "critical",
                        f"追價單 {order.id} 改價下單失敗，掛單已撤、剩量 {remaining} 未回補！")
                except Exception:
                    pass
                return
            ids = self._trade_id_candidates(result)
            with self._lock:
                order.chase_price = new_price
                order.reprice_count += 1
                if ids:
                    order.broker_order_ids = ",".join(ids)
                    self._chase_all_ids.setdefault(order.id, set()).update(ids)
                    self._add_leg_nolock(order, ids)   # 新腿：各腿獨立記帳（P1-2）
                rt = self._chase_runtime.setdefault(order.id, {})
                rt["last_reprice_ms"] = self._now_ms()
                rt["last_place_ms"] = self._now_ms()
            self._persist(order)
            self._emit_update(order)
            logger.info(f"[SmartOrder] CHASE {order.id} 改價 → {new_price} "
                        f"x{remaining} ({order.reprice_count}/{order.max_chase_ticks})")
        finally:
            self._chase_busy.discard(order.id)

    def _finalize_chase(self, order: SmartOrder):
        """追到上限（order executor）：撤單後依 final_action 收尾。

        P0-1 同 _reprice_chase：MARKET 剩量轉市價前，先確認撤單終態與實際剩量。
        """
        try:
            if not order.is_active or order.chase_status != ChaseStatus.CHASING:
                return
            has_working = bool([x for x in (order.broker_order_ids or "").split(",") if x])
            if has_working:
                if not self._cancel_broker_order(order):
                    logger.warning(f"[SmartOrder] CHASE {order.id} 收尾撤單失敗，略過本輪")
                    return
                confirmed = self._confirm_and_settle_cancel(order)
                if confirmed is False:
                    logger.warning(f"[SmartOrder] CHASE {order.id} 收尾撤單未確認，本輪略過")
                    return
            # 撤舊單後、送市價前二次驗證（可能已被取消）
            with self._lock:
                if not order.is_active or order.chase_status != ChaseStatus.CHASING:
                    return
                remaining = order.remaining_qty
            if remaining <= 0:
                self._chase_terminal(order, ChaseStatus.FILLED)
                return
            if order.final_action == "MARKET":
                # 剩量轉市價（仍走統一下單路徑；price=0 表市價）
                result = self._safe_place(order.symbol, 0, order.action, remaining)
                if result == RATE_LIMITED:
                    # #8：暫態頻率限制不終結；舊單已撤、剩量待轉市價 → 下輪重試
                    with self._lock:
                        order.broker_order_ids = ""
                    logger.warning(f"[SmartOrder] CHASE {order.id} 收尾轉市價遇頻率限制，"
                                   f"下輪重試")
                    return
                if result == RISK_BLOCKED:
                    self._chase_terminal(order, ChaseStatus.RISK_BLOCKED)
                elif result:
                    self._chase_terminal(order, ChaseStatus.COMPLETED)
                else:
                    self._chase_terminal(order, ChaseStatus.FAILED)
                    try:
                        self.event_bus.on_error.emit(
                            "critical",
                            f"追價單 {order.id} 剩量轉市價失敗，剩量 {remaining} 未成交！")
                    except Exception:
                        pass
            else:
                self._chase_terminal(order, ChaseStatus.GAVE_UP)
        finally:
            self._chase_busy.discard(order.id)

    def _on_chase_fill(self, fill_data: dict):
        """成交回報 → 累計 chase 已成量；全成 → FILLED，部分成 → 續追剩量。"""
        fill_order_id = str(fill_data.get("order_id") or "")
        if not fill_order_id:
            return
        try:
            fqty = int(fill_data.get("qty") or fill_data.get("quantity") or 0)
        except (TypeError, ValueError):
            return
        if fqty <= 0:
            return
        dedupe_key = str(fill_data.get("id") or "")
        changed: List[SmartOrder] = []
        with self._lock:
            for order in self._smart_orders:
                if (order.order_type != SmartOrderType.CHASE
                        or not order.is_active
                        or order.chase_status != ChaseStatus.CHASING):
                    continue
                # 歷來所有單號都要對（改價前舊單的遲到成交也要入帳）
                known = self._chase_all_ids.get(order.id) or set(
                    x for x in (order.broker_order_ids or "").split(",") if x)
                if fill_order_id not in known:
                    continue
                if dedupe_key:
                    seen = self._chase_fill_seen.setdefault(order.id, set())
                    if dedupe_key in seen:
                        continue  # callback 與對帳路徑重複回報同一筆成交
                    seen.add(dedupe_key)
                # 累加到「這筆成交所屬的腿」（P1-2：各腿獨立記帳）
                leg = self._leg_for_id_nolock(order, fill_order_id)
                if leg is None:
                    legs = self._chase_legs.setdefault(order.id, [])
                    if legs:
                        leg = legs[-1]
                        leg["ids"].add(fill_order_id)
                    else:
                        leg = {"ids": {fill_order_id}, "filled": 0}
                        legs.append(leg)
                leg["filled"] += fqty
                self._recompute_filled_nolock(order)
                if order.filled_qty >= order.qty:
                    order.chase_status = ChaseStatus.FILLED
                    order.is_active = False
                    self._chase_runtime.pop(order.id, None)
                changed.append(order)
        for order in changed:
            self._persist(order)
            self._emit_update(order)
            if not order.is_active:
                logger.info(f"[SmartOrder] CHASE {order.id} 全部成交 → FILLED")

    def sync_broker_orders(self, broker_orders: List[dict],
                           snapshot_complete: bool = True):
        """
        委託對帳掛鉤（order_sync 每輪呼叫）+ 重啟 re-attach：

        broker_orders: [{"ids": [id/seqno/ordno...], "status": 狀態名, "filled_qty": n}]
        （來自 list_trades 的「全部」委託，不只活躍的）
        snapshot_complete: 本輪快照是否完整可信（任一帳號 update_status 失敗 →
            False）。不完整時不得據「掛單消失」把 chase 判為外部撤單（P1-4a），
            但正常 fill 補償仍保留。

        - 待 re-attach 的 chase：ordno 對得上活躍掛單 → 續追；
          連續 N 輪完整快照都對不上 → CANCELLED_EXTERNAL 終態並廣播（P1-4b）
        - 追價中的 chase：連續 N 輪完整快照掛單消失 → CANCELLED_EXTERNAL；
          明確 Cancelled/Failed 狀態 → 外部撤單；券商回報已全成 → FILLED
          （callback 漏接時的補償）；成交量以「該腿」累計對帳（P1-2/P1-3）
        """
        now = self._now_ms()
        terminal: List[tuple] = []   # (order, status)
        reattached: List[SmartOrder] = []
        changed: List[SmartOrder] = []
        orphan_cancel: List[SmartOrder] = []  # 判死前嘗試撤單（防券商端孤兒單）
        with self._lock:
            for order in self._smart_orders:
                if (order.order_type != SmartOrderType.CHASE
                        or not order.is_active
                        or order.chase_status != ChaseStatus.CHASING
                        or order.id in self._chase_busy):
                    continue
                my_ids = set(x for x in (order.broker_order_ids or "").split(",") if x)
                entry = None
                if my_ids:
                    for bo in broker_orders or []:
                        if my_ids & {str(i) for i in (bo.get("ids") or ())}:
                            entry = bo
                            break
                reattach = order.id in self._chase_reattach_pending

                if entry is None:
                    # 無 working 單（剛因暫態頻率限制清空、待下輪重掛）→ 不判外部撤單
                    if not my_ids:
                        continue
                    # (P1-4a) 快照不完整 → 不能據缺席判死；也不累計缺席輪數
                    if not snapshot_complete:
                        continue
                    if not reattach:
                        rt = self._chase_runtime.get(order.id) or {}
                        last_place = rt.get("last_place_ms")
                        if last_place is not None and \
                                (now - last_place) < self._external_cancel_grace_ms:
                            continue  # 剛送出，快照可能還沒看到 → 時間寬限
                    # (P1-4b) 完整快照中缺席 → 累計輪數，連續 N 輪才判死
                    cnt = self._chase_missing_rounds.get(order.id, 0) + 1
                    self._chase_missing_rounds[order.id] = cnt
                    if cnt < self._external_cancel_rounds:
                        continue
                    # （先佔 busy：行情執行緒不得在終態落地前再排改價）
                    self._chase_busy.add(order.id)
                    orphan_cancel.append(order)   # (P1-4c) 判死前嘗試撤單
                    terminal.append((order, ChaseStatus.CANCELLED_EXTERNAL))
                    continue

                # 對到委託 → 清除缺席計數
                self._chase_missing_rounds.pop(order.id, None)
                entry_ids = {str(i) for i in (entry.get("ids") or ())}
                status = str(entry.get("status") or "")
                broker_filled = entry.get("filled_qty")
                before = order.filled_qty
                # P1-2/P1-3：以「該腿」券商累計成交量對帳（不跨腿比較），
                # 並回填對到的所有識別碼；不再無條件把 filled_qty 抹平成 qty
                self._apply_leg_cumulative_nolock(order, entry_ids, broker_filled)

                if order.filled_qty >= order.qty:
                    order.filled_qty = order.qty
                    self._chase_busy.add(order.id)
                    terminal.append((order, ChaseStatus.FILLED))
                elif status == "Filled":
                    # 券商回報此腿全部成交、但我方累計 < qty（例如熔斷 reduce-only
                    # 縮量 #9）：以實際成交回報為準（不灌水到 qty），標 FILLED 終態
                    self._chase_busy.add(order.id)
                    terminal.append((order, ChaseStatus.FILLED))
                elif status in _BROKER_ACTIVE_STATUSES:
                    if reattach:
                        self._chase_reattach_pending.discard(order.id)
                        self._chase_runtime[order.id] = {
                            "last_reprice_ms": None,
                            "last_place_ms": now,
                        }
                        self._chase_all_ids.setdefault(order.id, set()).update(
                            my_ids | entry_ids)
                        reattached.append(order)
                    elif order.filled_qty != before:
                        changed.append(order)   # 成交量有更新 → 廣播
                else:
                    # Cancelled / Failed 等明確終態（狀態是權威的，單輪即判）→ 外部撤單
                    self._chase_busy.add(order.id)
                    terminal.append((order, ChaseStatus.CANCELLED_EXTERNAL))
        for order in orphan_cancel:
            try:
                self._dispatch_task(lambda o=order: self._cancel_broker_order(o))
            except Exception:
                pass
        for order, status in terminal:
            try:
                self._chase_terminal(order, status)
            finally:
                self._chase_busy.discard(order.id)
        for order in reattached:
            self._emit_update(order)
            logger.info(f"[SmartOrder] CHASE {order.id} 重啟 re-attach 成功，繼續追價 "
                        f"(掛價 {order.chase_price}, filled {order.filled_qty}/{order.qty})")
        for order in changed:
            self._persist(order)
            self._emit_update(order)

    # ──── 取消智慧單 ────

    def cancel(self, order_id: str) -> bool:
        """取消指定智慧單（CHASE 會同時把 working 掛單撤掉）"""
        cancelled: Optional[SmartOrder] = None
        with self._lock:
            for order in self._smart_orders:
                if order.id == order_id and order.is_active:
                    order.is_active = False
                    if order.order_type == SmartOrderType.CHASE:
                        order.chase_status = ChaseStatus.CANCELLED
                        self._chase_runtime.pop(order.id, None)
                        self._chase_reattach_pending.discard(order.id)
                    self._persist(order)
                    # 如果是 OCO，一併取消配對單
                    if order.linked_id:
                        self._cancel_linked(order.linked_id)
                    logger.info(f"[SmartOrder] 已取消 {order_id}")
                    cancelled = order
                    break
        if cancelled is None:
            return False
        if cancelled.order_type == SmartOrderType.CHASE:
            # 撤掛單是 broker I/O：丟 order executor，REST 路徑不阻塞。
            # #7：撤單失敗要告警（券商端可能仍有活著的孤兒單需人工處理）
            self._dispatch_task(lambda o=cancelled: self._cancel_with_alert(o))
            self._emit_update(cancelled)
        return True

    def _cancel_with_alert(self, order: SmartOrder) -> bool:
        """撤 chase 掛單；失敗時發 on_error 告警（避免券商端孤兒單無人管理，#7）。"""
        ok = self._cancel_broker_order(order)
        if not ok:
            logger.error(f"[SmartOrder] CHASE {order.id} 掛單撤單失敗，"
                         f"券商端可能殘留孤兒單！")
            try:
                self.event_bus.on_error.emit(
                    "critical",
                    f"追價單 {order.id} 取消時撤單失敗，券商端可能仍有活躍掛單，"
                    f"請至券商 App 確認！")
            except Exception:
                pass
        return ok

    def cancel_all(self, symbol: Optional[str] = None) -> int:
        """批次取消所有智慧單，回傳取消數量。"""
        count = 0
        chase_cancelled: List[SmartOrder] = []
        with self._lock:
            for order in self._smart_orders:
                if order.is_active:
                    if symbol is None or order.symbol == symbol.strip().upper():
                        order.is_active = False
                        if order.order_type == SmartOrderType.CHASE:
                            order.chase_status = ChaseStatus.CANCELLED
                            self._chase_runtime.pop(order.id, None)
                            self._chase_reattach_pending.discard(order.id)
                            chase_cancelled.append(order)
                        self._persist(order)
                        count += 1
        for order in chase_cancelled:
            self._dispatch_task(lambda o=order: self._cancel_with_alert(o))
            self._emit_update(order)
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

        # CHASE：更新最新成交價快取（取不到五檔時的對手價 fallback），
        # 並用 tick 也驅動一次追價檢查（沒有 BidAsk 串流的商品仍能追價）
        self._last_prices[symbol] = float(price)
        self._check_chase_orders(symbol)

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
            # 都代表「已消耗」（成功送出，或被風控攔下不重試）。
            # 例外：RATE_LIMITED（暫態頻率限制）視同下單失敗 → re-arm 重試，
            # 不可讓保護性停損因暫態限制無聲消失（#8）。
            if result and result != RATE_LIMITED:
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
        """成交回報: 檢查 Bracket 母單是否成交 / 累計 CHASE 成交量"""
        self._on_chase_fill(fill_data)
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
