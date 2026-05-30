"""
SmartOrderEngine — Scale-out / OCO / Bracket 行為測試

不去碰真實 Shioaji，注入 fake place_order_fn 觀察觸發行為。
"""
import importlib.util
import os
import sys
from unittest.mock import MagicMock

_HERE = os.path.dirname(__file__)
_LIGHTNING = os.path.abspath(os.path.join(_HERE, ".."))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


event_bus_mod = _load("event_bus", os.path.join(_LIGHTNING, "core", "event_bus.py"))
soe_mod = _load("smart_order_engine", os.path.join(_LIGHTNING, "core", "smart_order_engine.py"))
EventBus = event_bus_mod.EventBus
SmartOrderEngine = soe_mod.SmartOrderEngine
SmartOrderType = soe_mod.SmartOrderType


def _engine():
    bus = EventBus()
    placed = []
    def fake_place(symbol, price, action, qty):
        placed.append({"symbol": symbol, "price": price, "action": action, "qty": qty})
        m = MagicMock()
        m.order.id = f"FAKE-{len(placed)}"
        return m
    eng = SmartOrderEngine(bus, place_order_fn=fake_place)
    return bus, eng, placed


# ── Scale-out ──

def test_scale_out_creates_targets_plus_stop():
    bus, eng, placed = _engine()
    ids = eng.add_scale_out(
        "TXFR1", "Sell",
        targets=[{"price": 17050, "qty": 1}, {"price": 17080, "qty": 1}],
        stop_loss=16980,
    )
    # 2 個 target + 1 個 stop = 3 張單
    assert len(ids) == 3
    active = eng.get_active_orders("TXFR1")
    assert len(active) == 3
    target_prices = [o["trigger_price"] for o in active if o["qty"] == 1]
    assert 17050 in target_prices
    assert 17080 in target_prices
    assert 16980 in [o["trigger_price"] for o in active if o["qty"] >= 2]


def test_scale_out_with_runner_adds_trailing():
    bus, eng, placed = _engine()
    ids = eng.add_scale_out(
        "TXFR1", "Sell",
        targets=[{"price": 17050, "qty": 1}],
        stop_loss=16980,
        runner_trailing=20,
    )
    assert len(ids) == 3  # target + stop + runner
    active = eng.get_active_orders("TXFR1")
    trailings = [o for o in active if o["order_type"] == "TrailingStop"]
    assert len(trailings) == 1
    assert trailings[0]["trailing_offset"] == 20


def test_scale_out_first_target_triggers_on_price():
    bus, eng, placed = _engine()
    eng.add_scale_out(
        "TXFR1", "Sell",
        targets=[{"price": 17050, "qty": 1}, {"price": 17080, "qty": 1}],
        stop_loss=16980,
    )
    # 模擬 tick 漲到 17050 → 第一筆 target 應觸發 → 送出市價賣 1 口
    bus.on_tick.emit("TXFR1", {"Price": 17050})
    assert any(p["price"] == 0 and p["qty"] == 1 and p["action"] == "Sell" for p in placed)


def test_scale_out_stop_loss_triggers_with_full_qty():
    bus, eng, placed = _engine()
    eng.add_scale_out(
        "TXFR1", "Sell",
        targets=[{"price": 17050, "qty": 1}, {"price": 17080, "qty": 1}],
        stop_loss=16980,
    )
    # 跌到 16980 → 停損觸發；qty 應為 2（總部位）
    bus.on_tick.emit("TXFR1", {"Price": 16980})
    stop_fills = [p for p in placed if p["qty"] == 2]
    assert len(stop_fills) >= 1


# ── OCO ──

def test_oco_take_profit_cancels_stop_loss():
    bus, eng, placed = _engine()
    main_id = eng.add_oco("TXFR1", "Sell", 1, take_profit=17050, stop_loss=16950)
    # 漲到 17050 → TP 觸發
    bus.on_tick.emit("TXFR1", {"Price": 17050})
    active = [o for o in eng.get_all_orders() if o["is_active"]]
    # 兩張都應為 inactive：一張被觸發、配對單被自動取消
    assert len(active) == 0


def test_oco_stop_loss_cancels_take_profit():
    bus, eng, placed = _engine()
    eng.add_oco("TXFR1", "Sell", 1, take_profit=17050, stop_loss=16950)
    bus.on_tick.emit("TXFR1", {"Price": 16950})
    active = [o for o in eng.get_all_orders() if o["is_active"]]
    assert len(active) == 0
