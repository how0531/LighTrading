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


def test_tag_notes_default_null_and_update(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    tj.record_trade({"state": "deal", "ordno": "T1", "dealseq": 1, "code": "TXFR1",
                      "action": "Buy", "price": 17000, "quantity": 1})
    row = tj.fetch_fills(limit=1)[0]
    # 新欄位預設為 None
    assert row["tag"] is None
    assert row["notes"] is None
    fid = row["id"]
    # 標 tag + notes
    assert tj.update_fill_meta(fid, tag="突破追多", notes="照計畫進場，停損 16950") is True
    updated = tj.fetch_fills(limit=1)[0]
    assert updated["tag"] == "突破追多"
    assert updated["notes"] == "照計畫進場，停損 16950"


def test_update_fill_meta_partial_and_clear(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    tj.record_trade({"state": "deal", "ordno": "T2", "dealseq": 1, "code": "MXFR1",
                      "action": "Sell", "price": 17000, "quantity": 1})
    fid = tj.fetch_fills(limit=1)[0]["id"]
    tj.update_fill_meta(fid, tag="逆勢", notes="不該做")
    # 只更新 notes，tag 不動（傳 None）
    tj.update_fill_meta(fid, notes="復盤：違反紀律")
    r = tj.fetch_fills(limit=1)[0]
    assert r["tag"] == "逆勢"
    assert r["notes"] == "復盤：違反紀律"
    # 空字串 = 清空 tag
    tj.update_fill_meta(fid, tag="")
    assert tj.fetch_fills(limit=1)[0]["tag"] == ""


def test_update_fill_meta_unknown_id_returns_false(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    assert tj.update_fill_meta("no-such-id", tag="x") is False
    assert tj.update_fill_meta("", tag="x") is False
    # 沒帶任何欄位也回 False
    tj.record_trade({"state": "deal", "ordno": "T3", "dealseq": 1, "code": "TXFR1",
                      "action": "Buy", "price": 17000, "quantity": 1})
    fid = tj.fetch_fills(limit=1)[0]["id"]
    assert tj.update_fill_meta(fid) is False


def test_stats_by_tag_aggregation(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    for i, (code, tag) in enumerate([("TXFR1", "突破"), ("TXFR1", "突破"), ("MXFR1", "")]):
        tj.record_trade({"state": "deal", "ordno": f"S{i}", "dealseq": 1, "code": code,
                          "action": "Buy", "price": 17000, "quantity": 1})
        fid = tj.fetch_fills(limit=1)[0]["id"]
        if tag:
            tj.update_fill_meta(fid, tag=tag)
    s = tj.fetch_stats()
    by_tag = {x["tag"]: x["fills"] for x in s["by_tag"]}
    assert by_tag["突破"] == 2
    assert by_tag["(未標記)"] == 1


def test_migration_adds_columns_to_legacy_db(tmp_path):
    """模擬舊 DB（無 tag/notes 欄），_connect 應自動補欄不報錯。"""
    import sqlite3
    db = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(db))
    conn.execute("""
        CREATE TABLE fills (
            id TEXT PRIMARY KEY, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
            action TEXT NOT NULL, price REAL NOT NULL, qty INTEGER NOT NULL,
            order_id TEXT, raw TEXT, created_at INTEGER NOT NULL
        )
    """)
    conn.execute(
        "INSERT INTO fills VALUES ('old1', 1715000000000, 'TXFR1', 'Buy', 17000, 1, 'O1', '', 1715000000000)"
    )
    conn.commit()
    conn.close()
    tj = _fresh_module(db)
    row = tj.fetch_fills(limit=1)[0]
    assert row["id"] == "old1"
    assert row["tag"] is None and row["notes"] is None
    assert tj.update_fill_meta("old1", tag="回測標的") is True
    assert tj.fetch_fills(limit=1)[0]["tag"] == "回測標的"


def test_import_fills_basic(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    result = tj.import_fills([
        {"ts": 1715000000000, "symbol": "TXFR1", "action": "Buy",  "price": 17000, "qty": 1, "order_id": "A1"},
        {"ts": 1715000060000, "symbol": "TXFR1", "action": "Sell", "price": 17020, "qty": 1, "order_id": "A2"},
    ])
    assert result["accepted"] == 2
    assert result["skipped"] == 0
    assert tj.fetch_fills(limit=10)[0]["symbol"] == "TXFR1"


def test_import_fills_idempotent(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    rows = [{"ts": 1715000000000, "symbol": "MXFR1", "action": "Buy", "price": 17000, "qty": 2, "order_id": "B1"}]
    tj.import_fills(rows)
    tj.import_fills(rows)  # 再跑一次同樣資料
    fills = tj.fetch_fills(limit=10)
    assert len(fills) == 1   # INSERT OR IGNORE 不會重複


def test_import_fills_skips_invalid_rows(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    result = tj.import_fills([
        {"ts": 0,                 "symbol": "TXFR1", "action": "Buy",     "price": 17000, "qty": 1},   # 0 ts → skip
        {"ts": 1715000000000,                       "action": "Buy",     "price": 17000, "qty": 1},   # 缺 symbol → skip
        {"ts": 1715000000000, "symbol": "TXFR1",   "action": "INVALID", "price": 17000, "qty": 1},   # action 不認 → skip
        {"ts": 1715000000000, "symbol": "TXFR1",   "action": "Buy",     "price": 0,     "qty": 1},   # price 0 → skip
        {"ts": 1715000000000, "symbol": "TXFR1",   "action": "Buy",     "price": 17000, "qty": 0},   # qty 0 → skip
        {"ts": 1715000000000, "symbol": "TXFR1",   "action": "Buy",     "price": 17000, "qty": 1},   # 合法
    ])
    assert result["accepted"] == 1
    assert result["skipped"] == 5


def test_import_fills_normalises_action_short_form(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    tj.import_fills([
        {"ts": 1715000000000, "symbol": "TXFR1", "action": "b", "price": 17000, "qty": 1, "order_id": "X"},
        {"ts": 1715000060000, "symbol": "TXFR1", "action": "S", "price": 17020, "qty": 1, "order_id": "Y"},
    ])
    fills = tj.fetch_fills(limit=10)
    actions = sorted(f["action"] for f in fills)
    assert actions == ["Buy", "Sell"]


def test_bad_input_returns_false(tmp_path):
    tj = _fresh_module(tmp_path / "j.db")
    # 缺價、缺量、缺商品都該被拒
    assert tj.record_trade({"state": "deal", "price": 17000, "quantity": 1}) is False
    assert tj.record_trade({"state": "deal", "code": "TXFR1", "quantity": 1}) is False
    assert tj.record_trade({"state": "deal", "code": "TXFR1", "price": -5, "quantity": 1}) is False
