"""
pnl_broadcaster 純函式單元測試

不去碰 asyncio 主迴圈（會牽涉到 WebSocket、shioaji 連線），只測試
_compute_pnl_payload() 的計算邏輯。這是 Sprint 0 S0-1 的核心改動。

驗證：
1. 期貨乘數正確（TXF=200, MXF=50, EXF=4000）
2. Buy 多單做對方向 → 正 PnL
3. Sell 空單做對方向 → 正 PnL
4. _latest_prices 找不到 key → 退回 broker 的 pnl
5. 多商品同時計算 total_pnl
"""
import sys
import os
from unittest.mock import MagicMock

from backend.services import pnl_broadcaster as pb
from backend import shared


def _setup_client(latest_prices: dict):
    """注入一個 mock shioaji client（只給 _latest_prices）。"""
    fake = MagicMock()
    fake._latest_prices = latest_prices
    shared.shioaji_client = fake


def test_multiplier_lookup():
    assert pb._get_multiplier("TXFR1") == 200
    assert pb._get_multiplier("MXFR1") == 50
    assert pb._get_multiplier("EXFR1") == 4000
    assert pb._get_multiplier("2330")  == 1000  # default 給股票


def test_long_position_positive_pnl():
    _setup_client({"TXFR1": 17050.0})
    pb._pos_cache = [{
        "symbol": "TXFR1", "qty": 1, "direction": "Buy",
        "price": 17000.0, "pnl": 0,
    }]
    payload = pb._compute_pnl_payload()
    # (17050 - 17000) * 1 * 200 = 10000
    assert payload["total_pnl"] == 10000
    assert payload["positions"][0]["realtimePnl"] == 10000


def test_short_position_with_falling_price():
    _setup_client({"TXFR1": 16950.0})
    pb._pos_cache = [{
        "symbol": "TXFR1", "qty": 2, "direction": "Sell",
        "price": 17000.0, "pnl": 0,
    }]
    payload = pb._compute_pnl_payload()
    # 空單跌 50 點 * 2 口 * 200 = 20000
    assert payload["total_pnl"] == 20000


def test_missing_price_falls_back_to_broker_pnl():
    _setup_client({})  # 拿不到最新價
    pb._pos_cache = [{
        "symbol": "TXFR1", "qty": 1, "direction": "Buy",
        "price": 17000.0, "pnl": 3500,  # broker 給的靜態 pnl
    }]
    payload = pb._compute_pnl_payload()
    assert payload["total_pnl"] == 3500
    assert payload["positions"][0]["realtimePnl"] == 3500


def test_multi_symbol_aggregation():
    _setup_client({"TXFR1": 17050.0, "MXFR1": 17050.0})
    pb._pos_cache = [
        {"symbol": "TXFR1", "qty": 1, "direction": "Buy",  "price": 17000.0, "pnl": 0},
        {"symbol": "MXFR1", "qty": 2, "direction": "Sell", "price": 17000.0, "pnl": 0},
    ]
    payload = pb._compute_pnl_payload()
    # TXFR1 多: +50 * 1 * 200 = +10000
    # MXFR1 空(跌變漲): -50 * 2 * 50 = -5000
    assert payload["total_pnl"] == 5000
