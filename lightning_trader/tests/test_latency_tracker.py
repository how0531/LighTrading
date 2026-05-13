"""
latency_tracker 純邏輯測試（不依賴 fastapi / shioaji）
"""
import importlib.util
import os
import sys
import time


_HERE = os.path.dirname(__file__)
_PATH = os.path.abspath(os.path.join(_HERE, "..", "backend", "services", "latency_tracker.py"))
_spec = importlib.util.spec_from_file_location("latency_tracker", _PATH)
_lt = importlib.util.module_from_spec(_spec)
sys.modules["latency_tracker"] = _lt
_spec.loader.exec_module(_lt)


def setup_function(_):
    _lt.reset()


def test_empty_metrics_returns_nulls():
    m = _lt.get_metrics()
    assert m["count"] == 0
    assert m["p50_ms"] is None
    assert m["p95_ms"] is None
    assert m["max_ms"] is None


def test_unpaired_fill_returns_none():
    # 沒先 on_place 就 on_fill → 對不到，回 None
    assert _lt.on_fill("X1") is None
    assert _lt.get_metrics()["count"] == 0


def test_basic_place_and_fill_records_sample():
    _lt.on_place("X1")
    time.sleep(0.005)
    elapsed = _lt.on_fill("X1")
    assert elapsed is not None
    assert elapsed >= 5.0   # 至少 5 ms（含 sleep）
    m = _lt.get_metrics()
    assert m["count"] == 1
    assert m["p50_ms"] is not None
    assert m["max_ms"] >= 5.0


def test_fill_pops_the_place_so_second_fill_is_unpaired():
    _lt.on_place("X2")
    _lt.on_fill("X2")
    # 第二次 fill 同 order_id 應該對不到（已被 pop）
    assert _lt.on_fill("X2") is None
    # 只應該有 1 筆樣本
    assert _lt.get_metrics()["count"] == 1


def test_quantiles_with_multiple_samples():
    # 構造 10 筆遞增延遲，p50≈中位，p95≈尾端
    for i in range(10):
        _lt.on_place(f"id{i}")
        time.sleep(0.002)  # 每筆遞增變短只是因為先後關係不重要；長 sleep 影響 test 時間，避免
    # 模擬不同延遲：手動 manipulate internal state 不太優；改成全部立刻 fill 但檢查順序
    for i in range(10):
        _lt.on_fill(f"id{i}")
    m = _lt.get_metrics()
    assert m["count"] == 10
    # 全部都 > 0
    assert m["p50_ms"] > 0
    assert m["p95_ms"] >= m["p50_ms"]
    assert m["max_ms"] >= m["p95_ms"]


def test_none_or_empty_order_id_is_noop():
    _lt.on_place(None)
    _lt.on_place("")
    assert _lt.on_fill(None) is None
    assert _lt.on_fill("") is None
    assert _lt.get_metrics()["count"] == 0


def test_ring_buffer_caps_at_200():
    for i in range(250):
        _lt.on_place(f"k{i}")
        _lt.on_fill(f"k{i}")
    m = _lt.get_metrics()
    assert m["count"] == 200   # 超過 200 之後 deque maxlen 丟舊
