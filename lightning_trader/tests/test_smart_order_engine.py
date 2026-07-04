"""
SmartOrderEngine 單元測試（離線，importlib 直載繞過 core/__init__ 的 shioaji 依賴）

覆蓋：
  - MIT gte/lte 觸發 + one-shot（不會重複觸發）
  - 移動停損 watermark 追蹤
  - OCO 一腿觸發取消另一腿
  - Bracket 母單成交 → 自動掛 OCO
  - cancel / cancel_all
  - SQLite 持久化：add → 重建 engine → re-arm；取消後不再還原
"""
import importlib.util
import os
import sys
from pathlib import Path

_HERE = os.path.dirname(__file__)
_LIGHTNING = os.path.abspath(os.path.join(_HERE, ".."))


def _load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


event_bus_mod = _load("t_event_bus", os.path.join(_LIGHTNING, "core", "event_bus.py"))
store_mod = _load("t_smart_order_store", os.path.join(_LIGHTNING, "core", "smart_order_store.py"))
engine_mod = _load("t_smart_order_engine", os.path.join(_LIGHTNING, "core", "smart_order_engine.py"))

EventBus = event_bus_mod.EventBus
SmartOrderStore = store_mod.SmartOrderStore
SmartOrderEngine = engine_mod.SmartOrderEngine


class OrderRecorder:
    def __init__(self, result=True):
        self.calls = []
        self.result = result

    def __call__(self, symbol, price, action, qty):
        self.calls.append({"symbol": symbol, "price": price, "action": action, "qty": qty})
        if self.result:
            from types import SimpleNamespace
            return SimpleNamespace(order=SimpleNamespace(id=f"ORD{len(self.calls)}"))
        return None


def _make(store=None, result=True):
    bus = EventBus()
    rec = OrderRecorder(result=result)
    eng = SmartOrderEngine(bus, place_order_fn=rec, store=store)
    return bus, rec, eng


# ─── MIT ────────────────────────────────────────────────────

def test_mit_gte_triggers_market_order():
    bus, rec, eng = _make()
    eng.add_mit("TXFA5", "Buy", 2, trigger_price=21000, condition="price_gte")
    bus.on_tick.emit("TXFA5", {"Price": 20999})
    assert rec.calls == []
    bus.on_tick.emit("TXFA5", {"Price": 21000})
    assert len(rec.calls) == 1
    assert rec.calls[0] == {"symbol": "TXFA5", "price": 0, "action": "Buy", "qty": 2}


def test_mit_lte_and_one_shot():
    bus, rec, eng = _make()
    eng.add_mit("TXFA5", "Sell", 1, trigger_price=20000, condition="price_lte")
    bus.on_tick.emit("TXFA5", {"Price": 19990})
    bus.on_tick.emit("TXFA5", {"Price": 19980})  # 不可重複觸發
    assert len(rec.calls) == 1
    assert eng.get_active_orders() == []


def test_mit_other_symbol_ignored():
    bus, rec, eng = _make()
    eng.add_mit("TXFA5", "Sell", 1, trigger_price=20000, condition="price_lte")
    bus.on_tick.emit("MXFA5", {"Price": 10})
    assert rec.calls == []


# ─── Trailing ───────────────────────────────────────────────

def test_trailing_stop_tracks_high_watermark():
    bus, rec, eng = _make()
    eng.add_trailing_stop("TXFA5", "Sell", 1, trailing_offset=20)
    bus.on_tick.emit("TXFA5", {"Price": 21000})  # 建立 watermark
    bus.on_tick.emit("TXFA5", {"Price": 21100})  # 創高 → watermark 上移
    bus.on_tick.emit("TXFA5", {"Price": 21085})  # 回檔 15 點，不觸發
    assert rec.calls == []
    bus.on_tick.emit("TXFA5", {"Price": 21080})  # 回檔 20 點 → 觸發
    assert len(rec.calls) == 1


def test_trailing_stop_short_side():
    bus, rec, eng = _make()
    eng.add_trailing_stop("TXFA5", "Buy", 1, trailing_offset=20)
    bus.on_tick.emit("TXFA5", {"Price": 21000})
    bus.on_tick.emit("TXFA5", {"Price": 20900})  # 創低
    bus.on_tick.emit("TXFA5", {"Price": 20920})  # 反彈 20 → 觸發回補
    assert len(rec.calls) == 1
    assert rec.calls[0]["action"] == "Buy"


# ─── OCO ────────────────────────────────────────────────────

def test_oco_trigger_cancels_linked_leg():
    bus, rec, eng = _make()
    eng.add_oco("TXFA5", "Sell", 1, take_profit=21100, stop_loss=20900)
    assert len(eng.get_active_orders()) == 2
    bus.on_tick.emit("TXFA5", {"Price": 21100})  # 停利腿觸發
    assert len(rec.calls) == 1
    assert eng.get_active_orders() == []          # 停損腿被 OCO 取消
    bus.on_tick.emit("TXFA5", {"Price": 20900})
    assert len(rec.calls) == 1                    # 不會再觸發


# ─── Bracket ────────────────────────────────────────────────

def test_bracket_fill_arms_oco():
    bus, rec, eng = _make()
    eng.add_bracket("TXFA5", "Buy", 1, entry_price=21000,
                    take_profit=21100, stop_loss=20900)
    assert len(rec.calls) == 1  # 進場限價單
    parent_id = "ORD1"
    bus.on_fill.emit({"order_id": parent_id, "symbol": "TXFA5",
                      "action": "Buy", "price": 21000, "qty": 1})
    active = eng.get_active_orders("TXFA5")
    oco = [o for o in active if o["order_type"] == "OCO"]
    assert len(oco) == 2
    assert all(o["action"] == "Sell" for o in oco)


def test_bracket_entry_failure_deactivates():
    bus, rec, eng = _make(result=False)
    eng.add_bracket("TXFA5", "Buy", 1, entry_price=21000,
                    take_profit=21100, stop_loss=20900)
    assert eng.get_active_orders() == []


# ─── cancel ─────────────────────────────────────────────────

def test_cancel_and_cancel_all():
    bus, rec, eng = _make()
    o1 = eng.add_mit("TXFA5", "Sell", 1, trigger_price=20000)
    eng.add_mit("MXFA5", "Sell", 1, trigger_price=15000)
    assert eng.cancel(o1.id) is True
    assert eng.cancel(o1.id) is False  # 已取消
    assert len(eng.get_active_orders()) == 1
    assert eng.cancel_all() == 1
    assert eng.get_active_orders() == []


# ─── 觸發下單結果處理（re-arm / RISK_BLOCKED 契約） ─────────

def test_trigger_place_failure_rearms_then_gives_up():
    """下單失敗（回 None）→ re-arm 重試；連續失敗達上限後放棄。"""
    bus, rec, eng = _make(result=False)
    eng.add_mit("TXFA5", "Sell", 1, trigger_price=20000, condition="price_lte")

    bus.on_tick.emit("TXFA5", {"Price": 19990})   # 第 1 次失敗 → re-arm
    assert len(eng.get_active_orders()) == 1
    bus.on_tick.emit("TXFA5", {"Price": 19990})   # 第 2 次失敗 → re-arm
    assert len(eng.get_active_orders()) == 1
    bus.on_tick.emit("TXFA5", {"Price": 19990})   # 第 3 次失敗 → 達上限放棄
    assert eng.get_active_orders() == []
    assert len(rec.calls) == 3


def test_trigger_risk_blocked_is_consumed_not_rearmed():
    """被風控攔下（回 RISK_BLOCKED 哨兵）→ 視為已消耗，不 re-arm 不重試。"""
    bus = EventBus()
    calls = []

    def blocked_place(symbol, price, action, qty):
        calls.append(1)
        return engine_mod.RISK_BLOCKED

    eng = SmartOrderEngine(bus, place_order_fn=blocked_place)
    eng.add_mit("TXFA5", "Buy", 1, trigger_price=21000, condition="price_gte")
    bus.on_tick.emit("TXFA5", {"Price": 21001})
    assert eng.get_active_orders() == []
    bus.on_tick.emit("TXFA5", {"Price": 21002})
    assert len(calls) == 1


def test_trigger_success_persists_consumed_state(tmp_path):
    """成功觸發後，重啟不得 re-arm（最終狀態已落地）。"""
    db = tmp_path / "smart.db"
    bus1, rec1, eng1 = _make(store=SmartOrderStore(Path(db)))
    eng1.add_mit("TXFA5", "Sell", 1, trigger_price=20000, condition="price_lte")
    bus1.on_tick.emit("TXFA5", {"Price": 19999})
    assert len(rec1.calls) == 1

    bus2, rec2, eng2 = _make(store=SmartOrderStore(Path(db)))
    assert eng2.get_active_orders() == []
    bus2.on_tick.emit("TXFA5", {"Price": 19999})
    assert rec2.calls == []


def test_oco_trigger_persists_linked_cancellation(tmp_path):
    """OCO 一腿觸發後重啟：另一腿不得復活。"""
    db = tmp_path / "smart.db"
    bus1, rec1, eng1 = _make(store=SmartOrderStore(Path(db)))
    eng1.add_oco("TXFA5", "Sell", 1, take_profit=21100, stop_loss=20900)
    bus1.on_tick.emit("TXFA5", {"Price": 21100})  # 停利腿觸發
    assert len(rec1.calls) == 1

    bus2, rec2, eng2 = _make(store=SmartOrderStore(Path(db)))
    assert eng2.get_active_orders() == []


# ─── 持久化 ─────────────────────────────────────────────────

def test_persistence_rearm_after_restart(tmp_path):
    db = tmp_path / "smart.db"
    store1 = SmartOrderStore(Path(db))
    bus1, rec1, eng1 = _make(store=store1)
    eng1.add_mit("TXFA5", "Sell", 3, trigger_price=20000, condition="price_lte")
    eng1.add_trailing_stop("2330", "Sell", 1, trailing_offset=5)

    # 模擬 backend 重啟：新 store + 新 engine
    store2 = SmartOrderStore(Path(db))
    bus2, rec2, eng2 = _make(store=store2)
    active = eng2.get_active_orders()
    assert len(active) == 2
    # 觸發還原後的停損 → 真的會下單
    bus2.on_tick.emit("TXFA5", {"Price": 19999})
    assert len(rec2.calls) == 1
    assert rec2.calls[0]["qty"] == 3


def test_persistence_cancelled_not_restored(tmp_path):
    db = tmp_path / "smart.db"
    store1 = SmartOrderStore(Path(db))
    bus1, rec1, eng1 = _make(store=store1)
    o = eng1.add_mit("TXFA5", "Sell", 1, trigger_price=20000)
    eng1.cancel(o.id)

    store2 = SmartOrderStore(Path(db))
    bus2, rec2, eng2 = _make(store=store2)
    assert eng2.get_active_orders() == []


def test_persistence_id_counter_resumes(tmp_path):
    db = tmp_path / "smart.db"
    store1 = SmartOrderStore(Path(db))
    bus1, rec1, eng1 = _make(store=store1)
    o1 = eng1.add_mit("TXFA5", "Sell", 1, trigger_price=20000)

    store2 = SmartOrderStore(Path(db))
    bus2, rec2, eng2 = _make(store=store2)
    o2 = eng2.add_mit("TXFA5", "Sell", 1, trigger_price=19000)
    assert o2.id != o1.id  # 重啟後不撞號
