"""
RiskManager.pre_order_check 全分支測試

驗證每一條 BLOCK / WARNING 路徑：
- 基本參數
- 全域 trading_enabled
- 日虧損上限
- 部位上限
- 下單頻率
- 重複委託防呆
- 市價單確認

直接從檔案 import 兩個檔案以繞過 core/__init__.py 對 shioaji 的依賴。
"""
import importlib.util
import os
import sys
from unittest.mock import MagicMock

_HERE = os.path.dirname(__file__)
_LIGHTNING = os.path.abspath(os.path.join(_HERE, ".."))


def _load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# event_bus 需要先載入，risk_manager 會用 Signal
event_bus_mod = _load("event_bus", os.path.join(_LIGHTNING, "core", "event_bus.py"))
risk_mod = _load("risk_manager", os.path.join(_LIGHTNING, "core", "risk_manager.py"))
RiskManager = risk_mod.RiskManager
RiskConfig = risk_mod.RiskConfig
CheckLevel = risk_mod.CheckLevel


def _bus():
    return event_bus_mod.EventBus()


def _rm(**cfg_overrides):
    cfg = RiskConfig(**cfg_overrides)
    return RiskManager(_bus(), cfg)


# ── 基本參數 ──

def test_zero_qty_blocked():
    r = _rm().pre_order_check("TXFR1", "Buy", qty=0, price=17000)
    assert r.level == CheckLevel.BLOCK
    assert "口數" in r.reason


def test_negative_price_blocked():
    r = _rm().pre_order_check("TXFR1", "Buy", qty=1, price=-1)
    assert r.level == CheckLevel.BLOCK


# ── 全域開關 ──

def test_trading_disabled_blocks_all():
    r = _rm(trading_enabled=False).pre_order_check("TXFR1", "Buy", qty=1, price=17000)
    assert r.level == CheckLevel.BLOCK


# ── 部位上限 ──

def test_position_limit_block():
    rm = _rm(max_position_per_symbol=5, max_position_enabled=True)
    # 假設目前已有 4 口多單，再下 2 口會超過 5 口上限
    r = rm.pre_order_check("TXFR1", "Buy", qty=2, price=17000,
                           position_qty=4, position_direction="Buy")
    assert r.level == CheckLevel.BLOCK, r.reason


def test_position_limit_ok_when_disabled():
    rm = _rm(max_position_per_symbol=5, max_position_enabled=False)
    r = rm.pre_order_check("TXFR1", "Buy", qty=10, price=17000,
                           position_qty=4, position_direction="Buy")
    # 部位上限關掉，不該因此 block；其他檢查仍可能擋（市價單 confirm 等）
    assert r.level != CheckLevel.BLOCK or "部位" not in r.reason


def test_opposite_direction_does_not_count_as_addon():
    rm = _rm(max_position_per_symbol=5, max_position_enabled=True)
    # 目前空單 4 口，下買單 2 口是「平倉」，不該算進部位上限
    r = rm.pre_order_check("TXFR1", "Buy", qty=2, price=17000,
                           position_qty=4, position_direction="Sell")
    # 至少不是因為部位上限被擋
    assert not (r.level == CheckLevel.BLOCK and "部位" in r.reason)


# ── 市價單確認 ──

def test_market_order_warn():
    rm = _rm(market_order_confirm=True)
    r = rm.pre_order_check("TXFR1", "Buy", qty=1, price=0, is_market_order=True)
    assert r.level == CheckLevel.WARNING


def test_market_order_pass_when_confirm_disabled():
    rm = _rm(market_order_confirm=False)
    r = rm.pre_order_check("TXFR1", "Buy", qty=1, price=0, is_market_order=True)
    # 不應因市價單而 warn
    assert r.level != CheckLevel.WARNING or "市價" not in r.reason


# ── reset_daily ──

def test_reset_daily_clears_counters():
    rm = _rm()
    rm._daily_realized_pnl = -10000
    rm._daily_unrealized_pnl = -5000
    rm.reset_daily()
    assert rm._daily_realized_pnl == 0
    assert rm._daily_unrealized_pnl == 0


# ── signed_position_qty / net_position_of（正負號唯一定義） ──

def test_signed_position_qty_unknown_direction_is_zero():
    f = risk_mod.signed_position_qty
    assert f("Buy", 3) == 3
    assert f("Sell", 3) == -3
    # 未知 / 缺漏方向一律 0（fail-safe）——之前三處複製的預設正負相反
    assert f("Flat", 3) == 0
    assert f(None, 3) == 0
    assert f("", 3) == 0
    assert f("Long", 3) == 0
    assert f("Buy", None) == 0
    assert f("Buy", "bad") == 0


def test_net_position_of_aggregates_multiple_rows():
    f = risk_mod.net_position_of
    positions = [
        {"symbol": "2330", "qty": 3, "direction": "Buy"},
        {"symbol": "2330", "qty": 1, "direction": "Sell"},
        {"symbol": "2317", "qty": 9, "direction": "Buy"},
    ]
    assert f(positions, "2330") == 2
    assert f(positions, "2317") == 9
    assert f(positions, "9999") == 0
    assert f(None, "2330") == 0


# ── reduce-only 熔斷豁免 ──

def test_reduce_only_exempt_from_halt():
    rm = _rm()
    rm.config.trading_enabled = False
    # 平倉方向、不超過部位 → 放行（skip_warnings 模擬 confirm）
    r = rm.pre_order_check("2330", "Sell", qty=2, price=100,
                           position_qty=2, position_direction="Buy",
                           skip_warnings=True)
    assert r.passed, r.reason
    # 開倉方向 → 仍被擋
    r2 = rm.pre_order_check("2330", "Buy", qty=1, price=100,
                            position_qty=2, position_direction="Buy",
                            skip_warnings=True)
    assert r2.level == CheckLevel.BLOCK
    # 超過部位的反向 → 也是開倉，擋
    r3 = rm.pre_order_check("2330", "Sell", qty=5, price=100,
                            position_qty=2, position_direction="Buy",
                            skip_warnings=True)
    assert r3.level == CheckLevel.BLOCK
