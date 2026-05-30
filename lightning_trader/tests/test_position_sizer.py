"""
position_sizer 純函式測試
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


ps = _load("position_sizer", os.path.join(_LIGHTNING, "core", "position_sizer.py"))


def test_txf_basic():
    """TXF entry 17000、stop 16995（距 5 點）、想冒險 2000 → 5*200=1000/口 → 2 口"""
    r = ps.calc_qty(risk_amount=2000, entry_price=17000, stop_price=16995, multiplier=200)
    assert r.qty == 2
    assert r.actual_risk == 2000
    assert r.risk_per_qty == 1000
    assert r.distance == 5
    assert r.warnings == []


def test_mxf_smaller_multiplier():
    """MXF mult=50；同樣 5 點停損、想冒險 500 → 5*50=250/口 → 2 口"""
    r = ps.calc_qty(risk_amount=500, entry_price=17000, stop_price=16995, multiplier=50)
    assert r.qty == 2
    assert r.actual_risk == 500


def test_stock_default_multiplier():
    """股票 mult=1：0050 25 元入、停損 24 元、想冒險 1000 → 1 元*1=1/股 → 1000 股
    股票數量級大，需放寬 max_qty"""
    r = ps.calc_qty(risk_amount=1000, entry_price=25.0, stop_price=24.0,
                    multiplier=1.0, max_qty=10000)
    assert r.qty == 1000


def test_insufficient_risk_gives_zero():
    """風險金額不足 1 口時 qty=0 + warning"""
    r = ps.calc_qty(risk_amount=100, entry_price=17000, stop_price=16995, multiplier=200)
    assert r.qty == 0
    assert any("不足以下 1 口" in w for w in r.warnings)


def test_zero_distance_returns_warning():
    r = ps.calc_qty(risk_amount=2000, entry_price=17000, stop_price=17000, multiplier=200)
    assert r.qty == 0
    assert any("相同" in w for w in r.warnings)


def test_max_qty_cap():
    """過大計算結果應被 max_qty 截斷"""
    r = ps.calc_qty(risk_amount=10_000_000, entry_price=17000, stop_price=16999,
                    multiplier=200, max_qty=10)
    assert r.qty == 10
    assert any("超過上限" in w for w in r.warnings)


def test_negative_risk_amount_blocked():
    r = ps.calc_qty(risk_amount=-100, entry_price=17000, stop_price=16995, multiplier=200)
    assert r.qty == 0


def test_stop_above_entry_short_position():
    """空單：entry 17000、stop 17005（距 5 點）；函式取絕對距離一樣處理"""
    r = ps.calc_qty(risk_amount=2000, entry_price=17000, stop_price=17005, multiplier=200)
    assert r.qty == 2
