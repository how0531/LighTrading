"""
CHASE 追價智慧單 — SmartOrderEngine 單元測試
（離線，importlib 直載繞過 core/__init__ 的 shioaji 依賴；模式同 test_smart_order_engine）

覆蓋：
  - 進場掛最佳對手價（Buy→ask1 / Sell→bid1；無五檔 → 最新成交價；無報價 → 不建單）
  - 對手價不利移動 ≥ reprice_ticks → cancel-replace 改價；有利移動不動作
  - reprice_interval_ms 節流
  - max_chase_ticks 上限：GIVE_UP（撤單）與 MARKET（剩量轉市價）兩路徑
  - 部分成交後續追剩量 / 全成 FILLED / fill id 去重
  - 取消（撤掛單 + CANCELLED）
  - 進場被風控攔（RISK_BLOCKED 終態，比照 MIT 觸發）
  - 對帳：外部撤單 → CANCELLED_EXTERNAL（寬限期內不誤判）
  - SQLite 持久化 + 重啟：re-attach 續追 / 對不上標終態並廣播（不留殭屍）
"""
import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace

_HERE = os.path.dirname(__file__)
_LIGHTNING = os.path.abspath(os.path.join(_HERE, ".."))


def _load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


event_bus_mod = _load("tc_event_bus", os.path.join(_LIGHTNING, "core", "event_bus.py"))
store_mod = _load("tc_smart_order_store", os.path.join(_LIGHTNING, "core", "smart_order_store.py"))
engine_mod = _load("tc_smart_order_engine", os.path.join(_LIGHTNING, "core", "smart_order_engine.py"))

EventBus = event_bus_mod.EventBus
SmartOrderStore = store_mod.SmartOrderStore
SmartOrderEngine = engine_mod.SmartOrderEngine
ChaseStatus = engine_mod.ChaseStatus


class ChaseBroker:
    """place + cancel 替身。place 回傳帶 id/seqno/ordno 的假 trade。"""

    def __init__(self):
        self.placed = []
        self.cancelled = []          # 每次撤單收到的 id 清單
        self.place_mode = "ok"       # ok | fail | blocked | rate_limited
        self.cancel_result = True
        # 撤單確認（P0-1）：測試設定 confirm(ids) 回傳值。
        #   dict {"cancelled": bool, "filled_qty": int} 或 None（逾時未確認）
        self.confirm_result = {"cancelled": True, "filled_qty": 0}
        self.on_cancel = None        # 撤單瞬間的競速鉤子（模擬撤單在途成交/使用者取消）
        self._seq = 0

    def place(self, symbol, price, action, qty):
        self.placed.append({"symbol": symbol, "price": price,
                            "action": action, "qty": qty})
        if self.place_mode == "blocked":
            return engine_mod.RISK_BLOCKED
        if self.place_mode == "rate_limited":
            return engine_mod.RATE_LIMITED
        if self.place_mode == "fail":
            return None
        self._seq += 1
        return SimpleNamespace(order=SimpleNamespace(
            id=f"ORD{self._seq}", seqno=f"SEQ{self._seq}", ordno=f"NO{self._seq}"))

    def cancel(self, ids):
        self.cancelled.append(list(ids))
        if self.on_cancel is not None:
            self.on_cancel(ids)
        return self.cancel_result

    def confirm(self, ids):
        return self.confirm_result


def _make(store=None, tick=1.0, confirm=False):
    bus = EventBus()
    broker = ChaseBroker()
    eng = SmartOrderEngine(bus, place_order_fn=broker.place, store=store,
                           cancel_order_fn=broker.cancel,
                           tick_size_fn=lambda p, s, t=tick: t)
    if confirm:
        # P0-1：注入撤單終態確認函數（cancel-replace 前先確認撤單 + 實際成交）
        eng.set_chase_helpers(confirm_cancel_fn=broker.confirm)
    return bus, broker, eng


def _quote(bus, symbol, bid, ask):
    bus.on_bidask.emit(symbol, {"BidPrice": [bid], "AskPrice": [ask]})


def _order_dict(eng, order_id):
    return next(o for o in eng.get_all_orders() if o["id"] == order_id)


# ─── 進場 ───────────────────────────────────────────────────

def test_chase_entry_buy_places_at_ask1():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    assert order is not None and order.chase_status == ChaseStatus.CHASING
    assert broker.placed == [{"symbol": "TXFA5", "price": 21001,
                              "action": "Buy", "qty": 2}]
    d = eng.get_active_orders("TXFA5")[0]
    assert d["order_type"] == "CHASE"
    assert d["initial_price"] == 21001 and d["chase_price"] == 21001
    assert d["reprice_count"] == 0 and d["remaining_qty"] == 2


def test_chase_entry_sell_places_at_bid1():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Sell", 1)
    assert order.chase_status == ChaseStatus.CHASING
    assert broker.placed[0]["price"] == 21000  # Sell → 買一


def test_chase_entry_falls_back_to_last_tick_price():
    bus, broker, eng = _make()
    bus.on_tick.emit("TXFA5", {"Price": 20990})  # 只有成交價、沒有五檔
    order = eng.add_chase("TXFA5", "Buy", 1)
    assert order.chase_status == ChaseStatus.CHASING
    assert broker.placed[0]["price"] == 20990


def test_chase_entry_without_any_quote_returns_none():
    bus, broker, eng = _make()
    assert eng.add_chase("TXFA5", "Buy", 1) is None
    assert broker.placed == []
    assert eng.get_all_orders() == []  # 不建單、不留殭屍


def test_chase_entry_risk_blocked_is_terminal():
    """進場被風控攔 → 比照 MIT 觸發被攔：已消耗、不重試。"""
    bus, broker, eng = _make()
    broker.place_mode = "blocked"
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    assert order.chase_status == ChaseStatus.RISK_BLOCKED
    assert eng.get_active_orders() == []
    _quote(bus, "TXFA5", 21005, 21006)  # 終態後不會追價
    assert broker.cancelled == []


def test_chase_entry_place_failure_is_terminal():
    bus, broker, eng = _make()
    broker.place_mode = "fail"
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    assert order.chase_status == ChaseStatus.FAILED
    assert eng.get_active_orders() == []


# ─── 追價（cancel-replace） ─────────────────────────────────

def test_chase_reprices_on_adverse_move():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    _quote(bus, "TXFA5", 21002, 21003)  # 賣一上移 2 ticks → 不利
    assert len(broker.cancelled) == 1
    assert "NO1" in broker.cancelled[0]  # 撤舊單（進場單）
    assert broker.placed[-1] == {"symbol": "TXFA5", "price": 21003,
                                 "action": "Buy", "qty": 2}
    d = eng.get_active_orders("TXFA5")[0]
    assert d["chase_price"] == 21003
    assert d["reprice_count"] == 1
    assert d["chase_status"] == ChaseStatus.CHASING
    assert order.broker_order_ids.startswith("ORD2")  # 追蹤新單號


def test_chase_sell_reprices_downward():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    eng.add_chase("TXFA5", "Sell", 1)
    _quote(bus, "TXFA5", 20998, 20999)  # 買一下移 → 不利
    assert broker.placed[-1]["price"] == 20998
    assert broker.placed[-1]["action"] == "Sell"


def test_chase_ignores_favorable_move():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    eng.add_chase("TXFA5", "Buy", 1)
    _quote(bus, "TXFA5", 20997, 20998)  # 賣一往下 → 有利，等成交即可
    assert broker.cancelled == []
    assert len(broker.placed) == 1


def test_chase_reprice_ticks_threshold():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    eng.add_chase("TXFA5", "Buy", 1, reprice_ticks=2)
    _quote(bus, "TXFA5", 21001, 21002)  # 只落後 1 tick < 2 → 不改價
    assert broker.cancelled == []
    _quote(bus, "TXFA5", 21002, 21003)  # 落後 2 ticks → 改價
    assert len(broker.cancelled) == 1
    assert broker.placed[-1]["price"] == 21003


def test_chase_reprice_interval_throttles():
    bus, broker, eng = _make()
    base = eng._now_ms()
    eng._now_ms = lambda: base                 # 固定時鐘
    _quote(bus, "TXFA5", 21000, 21001)
    eng.add_chase("TXFA5", "Buy", 1, reprice_interval_ms=1500)
    _quote(bus, "TXFA5", 21001, 21002)         # 第一次改價：尚無「上次改價」→ 放行
    assert len(broker.placed) == 2
    _quote(bus, "TXFA5", 21002, 21003)         # 距上次 0ms < 1500 → 節流
    _quote(bus, "TXFA5", 21003, 21004)
    assert len(broker.placed) == 2
    eng._now_ms = lambda: base + 1600          # 超過最小間隔
    _quote(bus, "TXFA5", 21003, 21004)
    assert len(broker.placed) == 3
    assert broker.placed[-1]["price"] == 21004
    d = eng.get_active_orders("TXFA5")[0]
    assert d["reprice_count"] == 2


# ─── max_chase_ticks 上限 ──────────────────────────────────

def test_chase_max_ticks_give_up():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2, max_chase_ticks=3)
    _quote(bus, "TXFA5", 21004, 21005)  # 新掛價距初始 4 ticks > 3 → GIVE_UP
    assert len(broker.cancelled) == 1   # 撤單
    assert len(broker.placed) == 1      # 不再掛新單
    assert eng.get_active_orders() == []
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.GAVE_UP
    _quote(bus, "TXFA5", 21006, 21007)  # 終態後不再動作
    assert len(broker.cancelled) == 1


def test_chase_max_ticks_market_fallback():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2, max_chase_ticks=3,
                          final_action="MARKET")
    _quote(bus, "TXFA5", 21004, 21005)
    assert len(broker.cancelled) == 1
    # 剩量轉市價（price=0），仍走統一下單路徑
    assert broker.placed[-1] == {"symbol": "TXFA5", "price": 0,
                                 "action": "Buy", "qty": 2}
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.COMPLETED
    assert eng.get_active_orders() == []


def test_chase_max_ticks_market_sends_remaining_after_partial_fill():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 3, max_chase_ticks=2,
                          final_action="MARKET")
    bus.on_fill.emit({"id": "F1", "order_id": "NO1", "qty": 2,
                      "symbol": "TXFA5", "action": "Buy", "price": 21001})
    _quote(bus, "TXFA5", 21004, 21005)  # 超限 → 撤單 + 剩量 1 口轉市價
    assert broker.placed[-1] == {"symbol": "TXFA5", "price": 0,
                                 "action": "Buy", "qty": 1}
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.COMPLETED
    assert d["filled_qty"] == 2


def test_chase_reprice_exactly_at_max_ticks_still_allowed():
    """距離「等於」max_chase_ticks 還能掛（> 才觸發 final_action）。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1, max_chase_ticks=3)
    _quote(bus, "TXFA5", 21003, 21004)  # 距初始恰 3 ticks = 上限 → 改價
    assert broker.placed[-1]["price"] == 21004
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.CHASING


# ─── 成交 ───────────────────────────────────────────────────

def test_chase_partial_fill_then_reprices_remaining():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 3)
    bus.on_fill.emit({"id": "F1", "order_id": "NO1", "qty": 1,
                      "symbol": "TXFA5", "action": "Buy", "price": 21001})
    d = _order_dict(eng, order.id)
    assert d["filled_qty"] == 1 and d["remaining_qty"] == 2
    assert d["chase_status"] == ChaseStatus.CHASING  # 部分成交 → 續追
    _quote(bus, "TXFA5", 21001, 21002)
    assert broker.placed[-1]["qty"] == 2  # 改價數量 = 未成交剩量


def test_chase_full_fill_marks_filled_and_stops():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    bus.on_fill.emit({"id": "F1", "order_id": "ORD1", "qty": 2,
                      "symbol": "TXFA5", "action": "Buy", "price": 21001})
    assert eng.get_active_orders() == []
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.FILLED
    assert d["filled_qty"] == 2 and d["remaining_qty"] == 0
    _quote(bus, "TXFA5", 21005, 21006)  # 已終態：不撤單不追價
    assert broker.cancelled == []
    assert len(broker.placed) == 1


def test_chase_fill_dedupes_by_fill_id():
    """同一筆成交從 callback 與對帳兩條路徑各回報一次 → 只入帳一次。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    fill = {"id": "NO1#77", "order_id": "NO1", "qty": 1,
            "symbol": "TXFA5", "action": "Buy", "price": 21001}
    bus.on_fill.emit(fill)
    bus.on_fill.emit(dict(fill))
    d = _order_dict(eng, order.id)
    assert d["filled_qty"] == 1  # 不會變 2


def test_chase_fill_on_old_order_after_reprice_still_counts():
    """改價後，舊單號的遲到成交仍要入帳（歷來單號都要對得上）。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    _quote(bus, "TXFA5", 21001, 21002)  # 改價 → 新單 NO2
    bus.on_fill.emit({"id": "F9", "order_id": "NO1", "qty": 1,
                      "symbol": "TXFA5", "action": "Buy", "price": 21001})
    d = _order_dict(eng, order.id)
    assert d["filled_qty"] == 1


# ─── 取消 ───────────────────────────────────────────────────

def test_chase_cancel_cancels_working_order():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    assert eng.cancel(order.id) is True
    assert len(broker.cancelled) == 1  # 掛單真的被撤
    assert eng.get_active_orders() == []
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.CANCELLED
    assert eng.cancel(order.id) is False  # 已取消
    _quote(bus, "TXFA5", 21005, 21006)    # 取消後不再追價
    assert len(broker.placed) == 1


def test_chase_cancel_all_cancels_working_orders():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    eng.add_chase("TXFA5", "Buy", 1)
    eng.add_mit("TXFA5", "Sell", 1, trigger_price=20000)
    assert eng.cancel_all() == 2
    assert len(broker.cancelled) == 1  # 只有 chase 需要撤掛單
    assert eng.get_active_orders() == []


# ─── 對帳：外部撤單偵測 ─────────────────────────────────────

def test_chase_external_cancel_detected_via_sync():
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    eng._external_cancel_grace_ms = 0.0
    updates = []
    bus.on_smart_order_updated.connect(updates.append)
    # 券商回報該掛單已被撤（外部管道動作）
    eng.sync_broker_orders([{"ids": ["NO1"], "status": "Cancelled", "filled_qty": 0}])
    assert eng.get_active_orders() == []
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.CANCELLED_EXTERNAL
    assert updates and updates[-1]["id"] == order.id  # 有廣播


def test_chase_missing_order_within_grace_not_flagged():
    """剛下單、對帳快照還沒看到 → 寬限期內不得誤判成外部撤單。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    eng.sync_broker_orders([])  # 快照沒有這張單（預設寬限 10s 內）
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.CHASING
    assert d["is_active"] is True


def test_chase_missing_order_after_grace_marked_external():
    """P1-4：掛單在「完整快照」中缺席，需連續 N 輪才判外部撤單（避免單輪劣化誤判）。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    eng._external_cancel_grace_ms = 0.0
    # 第一輪缺席：尚未達 N 輪 → 仍 CHASING（不誤判）
    eng.sync_broker_orders([])
    assert _order_dict(eng, order.id)["chase_status"] == ChaseStatus.CHASING
    # 第二輪仍缺席（連續 2 輪完整快照）→ 判外部撤單
    eng.sync_broker_orders([])
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.CANCELLED_EXTERNAL


def test_chase_incomplete_snapshot_never_flags_external():
    """P1-4a：快照不完整（某帳號 update_status 失敗）時，掛單缺席不得判外部撤單，
    即使連續多輪。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    eng._external_cancel_grace_ms = 0.0
    for _ in range(5):
        eng.sync_broker_orders([], snapshot_complete=False)
    assert _order_dict(eng, order.id)["chase_status"] == ChaseStatus.CHASING
    assert _order_dict(eng, order.id)["is_active"] is True


def test_chase_missing_then_reappears_resets_round_counter():
    """P1-4b：缺席計數在掛單重新出現時歸零，不會累積跨越間歇缺席而誤判。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    eng._external_cancel_grace_ms = 0.0
    eng.sync_broker_orders([])  # 缺席 1 輪
    eng.sync_broker_orders([{"ids": ["NO1"], "status": "Submitted", "filled_qty": 0}])  # 又出現
    eng.sync_broker_orders([])  # 再缺席 1 輪（計數已歸零 → 未達 N）
    assert _order_dict(eng, order.id)["chase_status"] == ChaseStatus.CHASING


def test_chase_sync_filled_compensation():
    """callback 漏接時，對帳回報 Filled → 補標 FILLED。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    eng.sync_broker_orders([{"ids": ["NO1"], "status": "Filled", "filled_qty": 2}])
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.FILLED
    assert d["filled_qty"] == 2


# ─── 持久化 / 重啟恢復 ──────────────────────────────────────

def test_chase_restart_reattaches_and_keeps_chasing(tmp_path):
    db = tmp_path / "smart.db"
    bus1, broker1, eng1 = _make(store=SmartOrderStore(Path(db)))
    _quote(bus1, "TXFA5", 21000, 21001)
    order = eng1.add_chase("TXFA5", "Buy", 2)

    # 模擬 backend 重啟
    bus2, broker2, eng2 = _make(store=SmartOrderStore(Path(db)))
    active = eng2.get_active_orders("TXFA5")
    assert len(active) == 1
    assert active[0]["chase_status"] == ChaseStatus.CHASING
    assert active[0]["chase_price"] == 21001  # 掛價還原

    # re-attach 完成前不追價（先等第一輪對帳確認掛單還在）
    _quote(bus2, "TXFA5", 21002, 21003)
    assert broker2.placed == []

    # 第一輪對帳：ordno 對上活躍掛單（含部分成交 1 口）→ 續追
    eng2.sync_broker_orders([{"ids": ["NO1"], "status": "PartFilled", "filled_qty": 1}])
    d = _order_dict(eng2, order.id)
    assert d["chase_status"] == ChaseStatus.CHASING
    assert d["filled_qty"] == 1  # 重啟期間的成交由對帳補回

    _quote(bus2, "TXFA5", 21002, 21003)  # 不利移動 → 續追剩量
    assert len(broker2.cancelled) == 1
    assert broker2.placed[-1] == {"symbol": "TXFA5", "price": 21003,
                                  "action": "Buy", "qty": 1}


def test_chase_restart_marks_terminal_when_order_gone(tmp_path):
    db = tmp_path / "smart.db"
    bus1, broker1, eng1 = _make(store=SmartOrderStore(Path(db)))
    _quote(bus1, "TXFA5", 21000, 21001)
    order = eng1.add_chase("TXFA5", "Buy", 2)

    bus2, broker2, eng2 = _make(store=SmartOrderStore(Path(db)))
    updates = []
    bus2.on_smart_order_updated.connect(updates.append)
    # re-attach 對不上任何 working order；同樣需連續 N 輪完整快照才判死（P1-4）
    eng2.sync_broker_orders([])
    assert eng2.get_active_orders() and eng2.get_active_orders()[0]["chase_status"] == ChaseStatus.CHASING
    eng2.sync_broker_orders([])  # 第二輪仍對不上 → 判死
    assert eng2.get_active_orders() == []
    d = _order_dict(eng2, order.id)
    assert d["chase_status"] == ChaseStatus.CANCELLED_EXTERNAL
    assert updates and updates[-1]["id"] == order.id  # 標終態並廣播

    # 再重啟一次：終態已落地，不會復活成殭屍
    bus3, broker3, eng3 = _make(store=SmartOrderStore(Path(db)))
    assert eng3.get_active_orders() == []


def test_chase_cancelled_not_restored(tmp_path):
    db = tmp_path / "smart.db"
    bus1, broker1, eng1 = _make(store=SmartOrderStore(Path(db)))
    _quote(bus1, "TXFA5", 21000, 21001)
    order = eng1.add_chase("TXFA5", "Buy", 1)
    eng1.cancel(order.id)

    bus2, broker2, eng2 = _make(store=SmartOrderStore(Path(db)))
    assert eng2.get_active_orders() == []


# ─── 廣播欄位（前端「追價中 3/10」） ────────────────────────

def test_chase_update_broadcast_contains_progress_fields():
    bus, broker, eng = _make()
    updates = []
    bus.on_smart_order_updated.connect(updates.append)
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2, max_chase_ticks=10)
    bus.on_fill.emit({"id": "F1", "order_id": "NO1", "qty": 1,
                      "symbol": "TXFA5", "action": "Buy", "price": 21001})
    _quote(bus, "TXFA5", 21001, 21002)  # 改價
    last = updates[-1]
    assert last["id"] == order.id
    assert last["chase_price"] == 21002      # 目前掛價
    assert last["reprice_count"] == 1        # 已改價次數
    assert last["remaining_qty"] == 1        # 剩量
    assert last["max_chase_ticks"] == 10
    assert last["chase_status"] == ChaseStatus.CHASING


# ─── P0-1：cancel-replace 撤單確認，撤單在途部分成交不超額 ──────────

def test_chase_reprice_confirms_cancel_and_uses_real_remaining():
    """撤單在途時舊單於交易所端部分成交 → 撤單確認回填實際已成，
    新腿只掛真正剩量，總量不超過 qty（P0-1 不變量）。"""
    bus, broker, eng = _make(confirm=True)
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 3)
    # 改價撤舊單時，舊單已在交易所端成交 2 口（撤單確認回報）
    broker.confirm_result = {"cancelled": True, "filled_qty": 2}
    _quote(bus, "TXFA5", 21002, 21003)  # 不利 → cancel-replace
    # 新腿只掛剩量 1（= 3 - 已成 2），不是盲送 3
    assert broker.placed[-1] == {"symbol": "TXFA5", "price": 21003,
                                 "action": "Buy", "qty": 1}
    d = _order_dict(eng, order.id)
    assert d["filled_qty"] == 2 and d["remaining_qty"] == 1
    # 不變量：活躍掛單量(1) + 已成(2) = 3 = qty，未超額建倉


def test_chase_reprice_fills_completely_during_cancel_no_new_leg():
    """撤單在途舊單全部成交 → 剩量 0，不再掛新單，標 FILLED。"""
    bus, broker, eng = _make(confirm=True)
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    broker.confirm_result = {"cancelled": True, "filled_qty": 2}
    n_before = len(broker.placed)
    _quote(bus, "TXFA5", 21002, 21003)
    assert len(broker.placed) == n_before   # 剩量 0 → 不掛新腿
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.FILLED
    assert d["filled_qty"] == 2


def test_chase_reprice_aborts_when_cancel_unconfirmed():
    """撤單未確認終態（逾時 / 仍在途）→ 不得送新單，保留舊單、下輪再試。"""
    bus, broker, eng = _make(confirm=True)
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    broker.confirm_result = None   # 撤單未確認
    n_before = len(broker.placed)
    _quote(bus, "TXFA5", 21002, 21003)
    assert len(broker.placed) == n_before          # 沒送新單
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.CHASING  # 仍在追、未終結
    assert order.broker_order_ids.startswith("ORD1")  # 舊單仍被追蹤


def test_chase_reprice_aborts_when_cancel_not_yet_terminal():
    """撤單確認回報「尚未撤掉」（cancelled=False）→ 同樣不送新單。"""
    bus, broker, eng = _make(confirm=True)
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)
    broker.confirm_result = {"cancelled": False, "filled_qty": 0}
    n_before = len(broker.placed)
    _quote(bus, "TXFA5", 21002, 21003)
    assert len(broker.placed) == n_before
    assert _order_dict(eng, order.id)["chase_status"] == ChaseStatus.CHASING


def test_chase_finalize_market_confirms_cancel_before_market():
    """MARKET 收尾也要先確認撤單 + 實際剩量再轉市價（P0-1）。"""
    bus, broker, eng = _make(confirm=True)
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 3, max_chase_ticks=2,
                          final_action="MARKET")
    broker.confirm_result = {"cancelled": True, "filled_qty": 2}  # 撤單時已成 2
    _quote(bus, "TXFA5", 21004, 21005)  # 超限 → 收尾
    # 剩量 1（3-2）轉市價，不是 3
    assert broker.placed[-1] == {"symbol": "TXFA5", "price": 0,
                                 "action": "Buy", "qty": 1}
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.COMPLETED
    assert d["filled_qty"] == 2


# ─── P1-2：跨腿漏接成交補償 ────────────────────────────────────

def test_chase_cross_leg_fill_compensation_via_sync():
    """改價後第二腿的漏接成交要能由對帳補回（不是拿當前腿量跟跨腿累計比大小）。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 3)     # 腿1 = NO1
    # 腿1 成交 1 口（callback）
    bus.on_fill.emit({"id": "F1", "order_id": "NO1", "qty": 1,
                      "symbol": "TXFA5", "action": "Buy", "price": 21001})
    _quote(bus, "TXFA5", 21001, 21002)           # 改價 → 腿2 = NO2（剩量 2）
    assert _order_dict(eng, order.id)["filled_qty"] == 1
    # 腿2 成交 1 口，callback 漏接、只有對帳看到（腿2 券商 deal_quantity=1）
    eng.sync_broker_orders([{"ids": ["NO2"], "status": "PartFilled", "filled_qty": 1}])
    d = _order_dict(eng, order.id)
    # 腿1(1) + 腿2(1) = 2；舊 bug（跨腿比大小）會卡在 1
    assert d["filled_qty"] == 2 and d["remaining_qty"] == 1


def test_chase_sync_does_not_inflate_filled_on_status_filled():
    """#9/P1-2：券商 status=Filled 但實際成交 < qty（熔斷 reduce-only 縮量）→
    filled_qty 以實際成交為準，不無條件抹平成 qty。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 3)
    # 券商回報此腿 Filled 但只成交 1 口（縮量）
    eng.sync_broker_orders([{"ids": ["NO1"], "status": "Filled", "filled_qty": 1}])
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.FILLED   # 委託鏈了結
    assert d["filled_qty"] == 1                       # 不虛報成 3


# ─── P1-3：ordno 後到仍能對帳 ──────────────────────────────────

def test_chase_late_ordno_backfilled_enables_match():
    """下單當下 ordno 常為空、成交回報才帶真 ordno：對帳把真 ordno 回填
    known-ids，之後 callback 用真 ordno 也對得上（P1-3）。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 2)   # 腿1 ids: ORD1/SEQ1/NO1
    # 對帳帶來真 ordno "REALNO"（透過 SEQ1 對上同一腿）→ 回填
    eng.sync_broker_orders([{"ids": ["SEQ1", "REALNO"],
                             "status": "Submitted", "filled_qty": 0}])
    # 之後成交回報只帶真 ordno → 仍對得上並入帳
    bus.on_fill.emit({"id": "F1", "order_id": "REALNO", "qty": 2,
                      "symbol": "TXFA5", "action": "Buy", "price": 21001})
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.FILLED
    assert d["filled_qty"] == 2


# ─── #6：取消與改價重疊 ────────────────────────────────────────

def test_chase_reprice_aborts_if_cancelled_during_replace():
    """撤舊單後、送新單前 chase 被取消 → 不掛新單（check-then-act 二次驗證）。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)

    def _racing_cancel(ids):
        # 模擬撤舊單瞬間使用者取消整張 chase
        order.is_active = False
        order.chase_status = ChaseStatus.CANCELLED
    broker.on_cancel = _racing_cancel

    n_before = len(broker.placed)
    _quote(bus, "TXFA5", 21002, 21003)
    assert len(broker.placed) == n_before   # 已取消 → 不掛新單
    assert _order_dict(eng, order.id)["chase_status"] == ChaseStatus.CANCELLED


# ─── #7：撤單失敗告警 ──────────────────────────────────────────

def test_chase_cancel_failure_emits_alert():
    """取消 chase 時撤單失敗 → 發 on_error 告警（券商端孤兒單不可無人管理）。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1)
    broker.cancel_result = False   # 撤單失敗
    errors = []
    bus.on_error.connect(lambda level, msg: errors.append((level, msg)))
    assert eng.cancel(order.id) is True
    assert errors and any("撤單失敗" in m for _, m in errors)


# ─── #8：暫態頻率限制不終結整張 chase ──────────────────────────

def test_chase_rate_limited_reprice_is_not_terminal():
    """改價時遇頻率限制（暫態 BLOCK）→ 不終結整張 chase，下輪重試。"""
    bus, broker, eng = _make()
    _quote(bus, "TXFA5", 21000, 21001)
    order = eng.add_chase("TXFA5", "Buy", 1, reprice_interval_ms=0)
    broker.place_mode = "rate_limited"
    _quote(bus, "TXFA5", 21002, 21003)   # 改價 → 撤舊單、新單遇頻率限制
    d = _order_dict(eng, order.id)
    assert d["chase_status"] == ChaseStatus.CHASING   # 未終結（非 RISK_BLOCKED）
    assert d["is_active"] is True
    assert order.broker_order_ids == ""               # 無 working 單，待重掛
    # 對帳此時也不得把「無 working 單」誤判為外部撤單
    eng._external_cancel_grace_ms = 0.0
    eng.sync_broker_orders([])
    eng.sync_broker_orders([])
    assert _order_dict(eng, order.id)["chase_status"] == ChaseStatus.CHASING
    # 下輪頻率恢復，價格續不利 → 重掛（不再重撤，因為本就無 working 單）
    broker.place_mode = "ok"
    n_cancel = len(broker.cancelled)
    _quote(bus, "TXFA5", 21004, 21005)
    assert order.broker_order_ids.startswith("ORD")   # 已重掛
    assert len(broker.cancelled) == n_cancel          # 沒有多餘撤單
