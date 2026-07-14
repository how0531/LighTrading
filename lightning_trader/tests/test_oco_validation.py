"""
C2：OCO / BRACKET 價格順序校驗 + OCO 同 tick 互斥。

  - 反向 tp/sl（Sell 平倉需 tp>sl、Buy 平倉需 tp<sl）→ REST 端回 422
    （比照既有 INVALID_OCO）。BRACKET 以「成交後自動掛的 OCO 方向 =
    進場方向的反向」套用同一規則。
  - 同一 tick 內若價格同時滿足 OCO 兩腿條件（tp==sl 之類退化/跳空邊界），
    只送一腿（先觸發者贏），另一腿被取消、不重複下單。
"""
import importlib.util
import os
import sys
from types import SimpleNamespace

import pytest

_HERE = os.path.dirname(__file__)
_LIGHTNING = os.path.abspath(os.path.join(_HERE, ".."))
sys.path.insert(0, _LIGHTNING)


# ── 引擎（離線 importlib 直載，模式同 test_smart_order_engine，繞過 core/__init__） ──
def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_eb = _load("toco_event_bus", os.path.join(_LIGHTNING, "core", "event_bus.py"))
_eng = _load("toco_smart_order_engine",
             os.path.join(_LIGHTNING, "core", "smart_order_engine.py"))
EventBus = _eb.EventBus
SmartOrderEngine = _eng.SmartOrderEngine

# ── REST 驗證函式（smart.py 不 import shioaji，可直接載入） ──
from backend.routers.smart import _validate_oco_prices  # noqa: E402
from fastapi import HTTPException  # noqa: E402


class _Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, symbol, price, action, qty):
        self.calls.append({"symbol": symbol, "price": price,
                           "action": action, "qty": qty})
        return SimpleNamespace(order=SimpleNamespace(id=f"ORD{len(self.calls)}"))


def _make_engine():
    bus = EventBus()
    rec = _Recorder()
    eng = SmartOrderEngine(bus, place_order_fn=rec)
    return bus, rec, eng


# ─── C2-a：REST 反向 tp/sl → 422 ────────────────────────────

def test_sell_oco_reversed_tp_sl_rejected():
    """Sell 平倉停利掛在停損下方（tp<sl）→ 422 INVALID_OCO。"""
    with pytest.raises(HTTPException) as ei:
        _validate_oco_prices("Sell", take_profit=20900, stop_loss=21100)
    assert ei.value.status_code == 422
    assert ei.value.detail["code"] == "INVALID_OCO"


def test_buy_oco_reversed_tp_sl_rejected():
    """Buy 平倉停利掛在停損上方（tp>sl）→ 422。"""
    with pytest.raises(HTTPException) as ei:
        _validate_oco_prices("Buy", take_profit=21100, stop_loss=20900)
    assert ei.value.status_code == 422
    assert ei.value.detail["code"] == "INVALID_OCO"


def test_equal_tp_sl_rejected_by_rest():
    """相等也非法（REST 要求嚴格順序）。"""
    with pytest.raises(HTTPException):
        _validate_oco_prices("Sell", 21000, 21000)


def test_valid_oco_prices_pass():
    """合理順序不拋。"""
    _validate_oco_prices("Sell", 21100, 20900)
    _validate_oco_prices("Buy", 20900, 21100)


# ─── C2-b：引擎 add_oco 防禦（最後一道防線） ────────────────

def test_engine_add_oco_defense_rejects_inversion():
    _, _, eng = _make_engine()
    with pytest.raises(ValueError):
        eng.add_oco("TXFA5", "Sell", 1, take_profit=20900, stop_loss=21100)
    with pytest.raises(ValueError):
        eng.add_oco("TXFA5", "Buy", 1, take_profit=21100, stop_loss=20900)
    assert eng.get_active_orders() == []  # 非法 → 不建單


# ─── C2-c：同 tick 只送一腿 ────────────────────────────────

def test_oco_same_tick_only_one_leg_sent():
    """tp==sl 退化：同一價同時滿足 GTE(tp) 與 LTE(sl) 兩腿，
    同 tick 互斥 → 只送一腿、另一腿取消，不重複下單。"""
    bus, rec, eng = _make_engine()
    eng.add_oco("TXFA5", "Sell", 1, take_profit=21000, stop_loss=21000)
    assert len(eng.get_active_orders()) == 2

    bus.on_tick.emit("TXFA5", {"Price": 21000})  # 同時命中兩腿
    assert len(rec.calls) == 1                    # 只送一腿
    assert eng.get_active_orders() == []          # 另一腿被取消（非重複下單）


def test_oco_same_tick_no_double_send_on_repeat_tick():
    """互斥後委託已了結：後續同價 tick 不會再補送另一腿。"""
    bus, rec, eng = _make_engine()
    eng.add_oco("TXFA5", "Sell", 1, take_profit=21000, stop_loss=21000)
    bus.on_tick.emit("TXFA5", {"Price": 21000})
    bus.on_tick.emit("TXFA5", {"Price": 21000})
    assert len(rec.calls) == 1
