"""
VWAPCalculator 測試
"""
import importlib.util
import os
import sys

_HERE = os.path.dirname(__file__)
_LIGHTNING = os.path.abspath(os.path.join(_HERE, ".."))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


event_bus_mod = _load("event_bus", os.path.join(_LIGHTNING, "core", "event_bus.py"))
vwap_mod = _load("vwap_calculator", os.path.join(_LIGHTNING, "core", "vwap_calculator.py"))
EventBus = event_bus_mod.EventBus
VWAPCalculator = vwap_mod.VWAPCalculator


def _feed(vwap, symbol, ticks):
    """ticks = [(price, volume), ...]"""
    for p, v in ticks:
        vwap._on_tick(symbol, {"Price": p, "Volume": v})


def test_vwap_single_tick():
    vw = VWAPCalculator(EventBus())
    _feed(vw, "TXFR1", [(17000, 10)])
    s = vw.get("TXFR1")
    assert s.vwap == 17000
    assert s.total_volume == 10
    assert s.tick_count == 1


def test_vwap_weighted_correctly():
    vw = VWAPCalculator(EventBus())
    # (17000*10 + 17050*30) / 40 = 17037.5
    _feed(vw, "TXFR1", [(17000, 10), (17050, 30)])
    s = vw.get("TXFR1")
    assert abs(s.vwap - 17037.5) < 1e-6
    assert s.total_volume == 40
    assert s.tick_count == 2


def test_vwap_per_symbol_independence():
    vw = VWAPCalculator(EventBus())
    _feed(vw, "TXFR1", [(17000, 10)])
    _feed(vw, "MXFR1", [(17050, 5)])
    assert vw.get("TXFR1").vwap == 17000
    assert vw.get("MXFR1").vwap == 17050


def test_vwap_returns_none_for_unseen_symbol():
    vw = VWAPCalculator(EventBus())
    assert vw.get("UNKNOWN") is None


def test_vwap_ignores_invalid_ticks():
    vw = VWAPCalculator(EventBus())
    _feed(vw, "TXFR1", [(0, 10), (17000, 0), (-1, 5), (17000, 10)])
    s = vw.get("TXFR1")
    assert s.total_volume == 10  # 只計第四筆


def test_vwap_reset_session_all():
    vw = VWAPCalculator(EventBus())
    _feed(vw, "TXFR1", [(17000, 10)])
    _feed(vw, "MXFR1", [(17050, 5)])
    vw.reset_session()
    assert vw.get("TXFR1") is None
    assert vw.get("MXFR1") is None


def test_vwap_reset_single_symbol():
    vw = VWAPCalculator(EventBus())
    _feed(vw, "TXFR1", [(17000, 10)])
    _feed(vw, "MXFR1", [(17050, 5)])
    vw.reset_session("TXFR1")
    assert vw.get("TXFR1") is None
    assert vw.get("MXFR1").vwap == 17050
