"""
SoundManager 測試（重寫版：事件路由器，後端不直接播音）
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
sound_mod = _load("sound_manager", os.path.join(_LIGHTNING, "core", "sound_manager.py"))
EventBus = event_bus_mod.EventBus
SoundManager = sound_mod.SoundManager


def _setup():
    bus = EventBus()
    emitted = []
    sm = SoundManager(bus, emit_fn=emitted.append)
    return bus, sm, emitted


def test_fill_event_triggers_sound():
    bus, sm, emitted = _setup()
    bus.on_fill.emit({"order_id": "X"})
    assert any(e["event"] == "fill" for e in emitted)


def test_muted_blocks_normal_events():
    bus, sm, emitted = _setup()
    sm.set_muted(True)
    bus.on_fill.emit({})
    bus.on_order_placed.emit({})
    assert emitted == []


def test_muted_does_not_block_unmutable():
    """風控警告 + 連線中斷不可靜音"""
    bus, sm, emitted = _setup()
    sm.set_muted(True)
    bus.on_risk_breach.emit("block", "日虧損觸頂")
    bus.on_connection_state.emit("disconnected")
    events = [e["event"] for e in emitted]
    assert "alert" in events
    assert "disconnect" in events


def test_unknown_event_ignored():
    bus, sm, emitted = _setup()
    sm.emit_sound("nonexistent")
    assert emitted == []


def test_emit_fn_lazy_set():
    """emit_fn 還沒注入時不該 crash"""
    bus = EventBus()
    sm = SoundManager(bus)   # 沒傳 emit_fn
    bus.on_fill.emit({})
    # 不 crash 即通過

    captured = []
    sm.set_emit_fn(captured.append)
    bus.on_fill.emit({})
    assert any(e["event"] == "fill" for e in captured)


def test_volume_clamped():
    bus, sm, _ = _setup()
    sm.set_volume(2.0)
    assert sm.volume == 1.0
    sm.set_volume(-1)
    assert sm.volume == 0.0


def test_smart_order_trigger_routes_to_sound():
    bus, sm, emitted = _setup()
    bus.on_smart_order_triggered.emit({"id": "SMART_0001"})
    assert any(e["event"] == "smart_trigger" for e in emitted)
