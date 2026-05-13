"""
trade_journal SQLite 落地 + 查詢測試

用環境變數把 DB 指到 tmp 路徑，避免污染 ~/.lightrade。
"""
import importlib
import os
import time
from pathlib import Path


def _fresh_module(tmp_db: Path):
    """每個 test 都重新 import，重置 module-level _CONN ref。"""
    import sys
    os.environ["LIGHTRADE_JOURNAL_DB"] = str(tmp_db)
    sys.modules.pop("backend.services.trade_journal", None)
    mod = importlib.import_module("backend.services.trade_journal")
    return mod


def test_records_fill_and_reads_back(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    ok = tj.record_trade({
        "state": "deal",
        "ordno": "X1", "dealseq": 1,
        "code": "TXFR1", "action": "Buy",
        "price": 17050, "quantity": 2,
    })
    assert ok
    rows = tj.fetch_fills(limit=10)
    assert len(rows) == 1
    r = rows[0]
    assert r["symbol"] == "TXFR1"
    assert r["action"] == "Buy"
    assert r["price"] == 17050.0
    assert r["qty"] == 2
    assert r["order_id"] == "X1"


def test_skip_non_deal_events(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    # state 不是 deal/fill → 被視為純狀態變更，跳過
    ok = tj.record_trade({
        "state": "submitted",
        "code": "TXFR1", "action": "Buy",
        "price": 17050, "quantity": 2,
    })
    assert ok is False
    assert tj.fetch_fills(limit=10) == []


def test_duplicate_id_is_idempotent(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    msg = {
        "state": "deal",
        "ordno": "X2", "dealseq": 5,
        "code": "MXFR1", "action": "Sell",
        "price": 17000, "quantity": 1,
    }
    assert tj.record_trade(msg) is True
    # 第二次同 ordno+dealseq → INSERT OR IGNORE 不會生新列
    assert tj.record_trade(msg) is True
    assert len(tj.fetch_fills(limit=10)) == 1


def test_fetch_filters_by_symbol_and_time(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    tj.record_trade({"state": "deal", "ordno": "A", "dealseq": 1, "code": "TXFR1", "action": "Buy",  "price": 17000, "quantity": 1})
    tj.record_trade({"state": "deal", "ordno": "B", "dealseq": 1, "code": "MXFR1", "action": "Sell", "price": 17000, "quantity": 1})
    tj.record_trade({"state": "deal", "ordno": "C", "dealseq": 1, "code": "TXFR1", "action": "Sell", "price": 17010, "quantity": 1})
    txf = tj.fetch_fills(symbol="TXFR1", limit=10)
    assert len(txf) == 2
    assert all(r["symbol"] == "TXFR1" for r in txf)


def test_stats_aggregates_correctly(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    tj.record_trade({"state": "deal", "ordno": "A", "dealseq": 1, "code": "TXFR1", "action": "Buy",  "price": 17000, "quantity": 3})
    tj.record_trade({"state": "deal", "ordno": "B", "dealseq": 1, "code": "TXFR1", "action": "Sell", "price": 17020, "quantity": 2})
    tj.record_trade({"state": "deal", "ordno": "C", "dealseq": 1, "code": "MXFR1", "action": "Buy",  "price": 17000, "quantity": 1})
    s = tj.fetch_stats()
    assert s["fills"] == 3
    assert s["buy_lots"] == 4
    assert s["sell_lots"] == 2
    assert len(s["top_symbols"]) == 2
    assert s["top_symbols"][0]["symbol"] == "TXFR1"
    assert s["top_symbols"][0]["fills"] == 2


def test_bad_input_returns_false(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    # 缺價、缺量、缺商品都該被拒
    assert tj.record_trade({"state": "deal", "price": 17000, "quantity": 1}) is False
    assert tj.record_trade({"state": "deal", "code": "TXFR1", "quantity": 1}) is False
    assert tj.record_trade({"state": "deal", "code": "TXFR1", "price": -5, "quantity": 1}) is False
