"""
SymbolResolver 單元測試

核心保證：
1. 期貨 tick.code（如 TXFE5）能映射回 user-facing symbol（TXFR1）
2. 股票 symbol == code，自我映射
3. 大小寫無關
4. 未登記的 code 直接回傳本身（保守降級）
5. 執行緒安全（多執行緒同時 register / canonical 不會 crash）
"""
import importlib.util
import os
import threading
from types import SimpleNamespace

# 直接從檔案 import，繞過 core/__init__.py 的 dotenv/shioaji 依賴
_HERE = os.path.dirname(__file__)
_SPEC = importlib.util.spec_from_file_location(
    "symbol_resolver",
    os.path.abspath(os.path.join(_HERE, "..", "core", "symbol_resolver.py")),
)
_module = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_module)
SymbolResolver = _module.SymbolResolver


def _contract(symbol: str, code: str | None = None):
    return SimpleNamespace(symbol=symbol, code=code or symbol)


def test_stock_symbol_is_self_alias():
    r = SymbolResolver()
    r.register(_contract("2330"))
    assert r.canonical("2330") == "2330"
    assert r.canonical("2330".lower()) == "2330"  # 大小寫無關


def test_futures_rolling_alias():
    """TXFR1 是滾動月，tick.code 會帶回實際合約月份 TXFE5"""
    r = SymbolResolver()
    r.register(_contract(symbol="TXFR1", code="TXFE5"))
    assert r.canonical("TXFE5") == "TXFR1"
    assert r.canonical("TXFR1") == "TXFR1"
    # 全小寫
    assert r.canonical("txfe5") == "TXFR1"


def test_unknown_passthrough():
    r = SymbolResolver()
    # 沒登記過的 raw 直接回傳本身 .upper()
    assert r.canonical("ABC123") == "ABC123"
    assert r.canonical("") == ""
    assert r.canonical(None) == ""


def test_register_pair_overrides():
    r = SymbolResolver()
    r.register_pair("FOO", "BAR")
    assert r.canonical("FOO") == "BAR"
    # 再 register_pair 同 code 會覆寫
    r.register_pair("FOO", "BAZ")
    assert r.canonical("FOO") == "BAZ"


def test_all_known_returns_canonical_set():
    r = SymbolResolver()
    r.register(_contract("TXFR1", "TXFE5"))
    r.register(_contract("2330"))
    known = r.all_known()
    assert "TXFR1" in known
    assert "2330" in known


def test_thread_safety():
    r = SymbolResolver()
    contracts = [_contract(f"SYM{i}", f"CODE{i}") for i in range(50)]

    def writer():
        for c in contracts:
            r.register(c)

    def reader():
        for c in contracts:
            r.canonical(c.code)

    threads = [threading.Thread(target=writer) for _ in range(4)]
    threads += [threading.Thread(target=reader) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 結果一致：每個 code 都映射到對應 symbol
    for c in contracts:
        assert r.canonical(c.code) == c.symbol
