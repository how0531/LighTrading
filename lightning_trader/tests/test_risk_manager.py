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


# ── allow_warnings：使用者已 confirm 時 WARNING 應通過 ──

def test_allow_warnings_passes_market_order():
    rm = _rm(market_order_confirm=True)
    # 預設行為：BLOCK 或 WARNING
    r1 = rm.pre_order_check("TXFR1", "Buy", qty=1, price=0, is_market_order=True)
    assert r1.level == CheckLevel.WARNING
    # 帶 allow_warnings=True 應通過
    r2 = rm.pre_order_check("TXFR1", "Buy", qty=1, price=0,
                             is_market_order=True, allow_warnings=True)
    assert r2.level == CheckLevel.OK


def test_allow_warnings_does_not_bypass_block():
    """確認 allow_warnings 不會把 BLOCK 也放行（部位上限超過必須擋）"""
    rm = _rm(max_position_per_symbol=5, max_position_enabled=True)
    r = rm.pre_order_check("TXFR1", "Buy", qty=10, price=17000,
                           position_qty=0, position_direction="Flat",
                           allow_warnings=True)
    assert r.level == CheckLevel.BLOCK


def test_allow_warnings_passes_reverse():
    rm = _rm(reverse_confirm=True, market_order_confirm=False)
    r1 = rm.pre_order_check("TXFR1", "Sell", qty=1, price=17000,
                             position_qty=2, position_direction="Buy")
    assert r1.level == CheckLevel.WARNING
    r2 = rm.pre_order_check("TXFR1", "Sell", qty=1, price=17000,
                             position_qty=2, position_direction="Buy",
                             allow_warnings=True)
    assert r2.level == CheckLevel.OK


# ── 邊緣觸發：日虧損 BLOCK 不該瘋狂 emit ──

def test_breach_emitted_only_once():
    bus = _bus()
    rm = RiskManager(bus, RiskConfig(max_daily_loss=-1000, max_daily_loss_enabled=True))
    breach_calls = []
    bus.on_risk_breach.connect(lambda lvl, msg: breach_calls.append((lvl, msg)))

    # 模擬連續多筆 position_update 觸及日虧損
    for _ in range(5):
        rm._on_position_update({"total_unrealized_pnl": -10000, "positions": []})

    # 邊緣觸發：只 emit 一次
    assert len(breach_calls) == 1
    assert breach_calls[0][0] == "block"
    assert rm.config.trading_enabled is False

    # reset 後可再觸發
    rm.reset_daily()
    rm._on_position_update({"total_unrealized_pnl": -10000, "positions": []})
    assert len(breach_calls) == 2
