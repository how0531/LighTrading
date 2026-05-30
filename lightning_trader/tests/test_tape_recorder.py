"""
TapeRecorder 測試
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
tape_mod = _load("tape_recorder", os.path.join(_LIGHTNING, "core", "tape_recorder.py"))
EventBus = event_bus_mod.EventBus
TapeRecorder = tape_mod.TapeRecorder


def test_tape_append_and_get():
    tr = TapeRecorder(EventBus())
    tr._on_tick("TXFR1", {"Price": 17000, "Volume": 1, "TickType": 1, "TickTime": "10:00:00"})
    tr._on_tick("TXFR1", {"Price": 17001, "Volume": 2, "TickType": 2, "TickTime": "10:00:01"})
    rows = tr.get("TXFR1")
    assert len(rows) == 2
    assert rows[0]["price"] == 17000
    assert rows[1]["tick_type"] == 2


def test_tape_limit():
    tr = TapeRecorder(EventBus())
    for i in range(20):
        tr._on_tick("TXFR1", {"Price": 17000 + i, "Volume": 1})
    rows = tr.get("TXFR1", limit=5)
    assert len(rows) == 5
    assert rows[-1]["price"] == 17019


def test_tape_maxlen_enforced():
    """超過 maxlen 後最舊的會被擠掉"""
    tr = TapeRecorder(EventBus(), maxlen=10)
    for i in range(15):
        tr._on_tick("TXFR1", {"Price": 17000 + i, "Volume": 1})
    rows = tr.get("TXFR1", limit=100)
    assert len(rows) == 10
    assert rows[0]["price"] == 17005   # 前 5 筆被擠掉
    assert rows[-1]["price"] == 17014


def test_tape_per_symbol():
    tr = TapeRecorder(EventBus())
    tr._on_tick("TXFR1", {"Price": 17000, "Volume": 1})
    tr._on_tick("MXFR1", {"Price": 17050, "Volume": 1})
    assert len(tr.get("TXFR1")) == 1
    assert len(tr.get("MXFR1")) == 1


def test_tape_ignores_invalid_ticks():
    tr = TapeRecorder(EventBus())
    tr._on_tick("TXFR1", {"Price": 0, "Volume": 5})
    tr._on_tick("TXFR1", {"Price": 17000, "Volume": 0})
    assert tr.get("TXFR1") == []


def test_tape_clear():
    tr = TapeRecorder(EventBus())
    tr._on_tick("TXFR1", {"Price": 17000, "Volume": 1})
    tr.clear("TXFR1")
    assert tr.get("TXFR1") == []
