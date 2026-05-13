"""
equity_curve FIFO 配對測試
"""
import importlib.util
import os
import sys

# 直接從檔案 import，繞過 backend/__init__.py 依賴
_HERE = os.path.dirname(__file__)
_PATH = os.path.abspath(os.path.join(_HERE, "..", "backend", "services", "equity_curve.py"))
_spec = importlib.util.spec_from_file_location("equity_curve", _PATH)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["equity_curve"] = _mod
_spec.loader.exec_module(_mod)
compute_realized_curve = _mod.compute_realized_curve


def F(ts, action, price, qty, symbol="TXFR1"):
    return {"ts": ts, "symbol": symbol, "action": action, "price": price, "qty": qty}


def test_empty_input_returns_empty():
    assert compute_realized_curve([]) == []


def test_single_open_no_realized():
    out = compute_realized_curve([F(1, "Buy", 17000, 2)])
    assert len(out) == 1
    assert out[0]["realized_pnl"] == 0
    assert out[0]["delta"] == 0


def test_long_then_close_at_higher_price():
    # Buy 1 @17000, Sell 1 @17050 → (17050-17000)*1*200 = 10000
    out = compute_realized_curve([
        F(1, "Buy",  17000, 1),
        F(2, "Sell", 17050, 1),
    ])
    assert out[0]["realized_pnl"] == 0
    assert out[1]["realized_pnl"] == 10000
    assert out[1]["delta"] == 10000


def test_short_then_buy_back_for_profit():
    # Sell 1 @17050, Buy 1 @17000 → (17050-17000)*1*200 = 10000 (short profit)
    out = compute_realized_curve([
        F(1, "Sell", 17050, 1),
        F(2, "Buy",  17000, 1),
    ])
    assert out[1]["realized_pnl"] == 10000


def test_partial_close_then_full_close():
    # Buy 3 @17000
    # Sell 1 @17050 → close 1 → +50pt * 1 * 200 = +10000
    # Sell 2 @16950 → close 2 → -50pt * 2 * 200 = -20000
    # cumulative: -10000
    out = compute_realized_curve([
        F(1, "Buy",  17000, 3),
        F(2, "Sell", 17050, 1),
        F(3, "Sell", 16950, 2),
    ])
    assert out[1]["realized_pnl"] == 10000
    assert out[2]["delta"] == -20000
    assert out[2]["realized_pnl"] == -10000


def test_reverse_through_fifo():
    # Buy 1 @17000  → long 1
    # Sell 3 @17050 → close 1 (+10000) + open short 2
    # Buy 2 @17030  → close shorts (+20*2*200 = +8000)
    # cumulative: 18000
    out = compute_realized_curve([
        F(1, "Buy",  17000, 1),
        F(2, "Sell", 17050, 3),
        F(3, "Buy",  17030, 2),
    ])
    assert out[1]["delta"] == 10000
    assert out[2]["delta"] == 8000
    assert out[2]["realized_pnl"] == 18000


def test_multiple_symbols_isolated():
    # TXF 多空配對 vs MXF 多空配對 互不影響
    out = compute_realized_curve([
        F(1, "Buy",  17000, 1, "TXFR1"),
        F(2, "Buy",  17000, 1, "MXFR1"),
        F(3, "Sell", 17050, 1, "TXFR1"),   # +50 * 200 = +10000
        F(4, "Sell", 17100, 1, "MXFR1"),   # +100 * 50  = +5000
    ])
    assert out[2]["delta"] == 10000
    assert out[3]["delta"] == 5000
    assert out[3]["realized_pnl"] == 15000


def test_invalid_inputs_skipped():
    out = compute_realized_curve([
        F(1, "Buy", 0, 1),       # 0 price → skip
        F(2, "Sell", 17000, 0),  # 0 qty → skip
        {"ts": 3},                # missing fields → skip
        F(4, "Buy", 17000, 1),
    ])
    # 只有最後一筆有效，realized = 0（開倉）
    assert len(out) == 1
    assert out[0]["ts"] == 4
