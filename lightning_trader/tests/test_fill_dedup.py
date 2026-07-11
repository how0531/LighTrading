"""
成交去重測試（A2）——「同一筆成交」在兩條路徑必須產生同一個決定性權威鍵。

兩條落地路徑：
  - callback 路徑：trade_journal.extract_fill / record_trade
  - 對帳路徑：order_sync.extract_deal_fills → trade_journal.insert_fill

重點情境：Deal **缺** exchange_seq/dealseq/seq（callback dict 與對應 list_trades
Deal 都缺序號）。此時必須退回內容組合鍵 `ordno#price#qty#累計量` —— 絕不落到
wall-clock，否則兩路徑 id 分歧、INSERT OR IGNORE 去重失效、已實現損益翻倍。
"""
import importlib
import os
import sys
import time
import types


def _fresh(tmp_db):
    """把 journal DB 指到 tmp，重載 trade_journal + order_sync（同一份 module 實例）。"""
    os.environ["LIGHTRADE_JOURNAL_DB"] = str(tmp_db)
    for name in ("backend.services.order_sync", "backend.services.trade_journal"):
        sys.modules.pop(name, None)
    tj = importlib.import_module("backend.services.trade_journal")
    osync = importlib.import_module("backend.services.order_sync")
    return tj, osync


# ── 假的 shioaji Trade / Deal（給 order_sync.extract_deal_fills 用）──
def _fake_trade(ordno, symbol, action, deals):
    order = types.SimpleNamespace(ordno=ordno, seqno="", id="", action=action)
    contract = types.SimpleNamespace(code=symbol, symbol=symbol)
    status = types.SimpleNamespace(deals=deals)
    return types.SimpleNamespace(order=order, contract=contract, status=status)


def _deal(price, qty, seq=None, ts=None):
    return types.SimpleNamespace(price=price, quantity=qty,
                                 seq=("" if seq is None else seq),
                                 ts=(ts if ts is not None else time.time() * 1000))


def test_same_authoritative_id_when_seq_missing(tmp_path):
    """缺序號時，兩路徑對同一筆成交必須推導出同一個 id（內容組合鍵）。"""
    tj, osync = _fresh(tmp_path / "j.db")

    now_ms = int(time.time() * 1000)
    callback = {
        "state": "deal",
        "ordno": "A1", "code": "TXFR1", "action": "Buy",
        "price": 17050, "quantity": 2,
        # ★ 沒有 exchange_seq / dealseq / seq
    }
    cb_fill = tj.extract_fill(callback)
    assert cb_fill is not None

    trade = _fake_trade("A1", "TXFR1", "Buy", [_deal(17050, 2, seq=None, ts=now_ms)])
    sync_fills = osync.extract_deal_fills([trade])
    assert len(sync_fills) == 1

    # 兩路徑同一 id，且不得含 wall-clock（純內容鍵）
    assert cb_fill["id"] == sync_fills[0]["id"]
    assert cb_fill["id"] == "A1#17050.000000#2#2"


def test_journal_single_row_and_reconcile_zero_new(tmp_path):
    """callback 先落地 → 對帳路徑再跑一輪：journal 只 1 列、new_fills == 0。"""
    tj, osync = _fresh(tmp_path / "j.db")
    now_ms = int(time.time() * 1000)

    # 1) callback 路徑落地
    assert tj.record_trade({
        "state": "deal", "ordno": "A1", "code": "TXFR1", "action": "Buy",
        "price": 17050, "quantity": 2,
    }) is True
    assert len(tj.fetch_fills(limit=10)) == 1

    # 2) 對帳路徑（模擬 sync_once 的入帳迴圈）
    trade = _fake_trade("A1", "TXFR1", "Buy", [_deal(17050, 2, seq=None, ts=now_ms)])
    new_fills = 0
    for f in osync.extract_deal_fills([trade]):
        if tj.insert_fill(f):
            new_fills += 1

    assert new_fills == 0                       # 同一筆成交，對帳不應新增
    assert len(tj.fetch_fills(limit=10)) == 1   # journal 仍只 1 列


def test_content_dedup_catches_divergent_id(tmp_path):
    """縱深防禦：即使兩路徑 id 不同（一邊有序號一邊沒有），內容型防重仍擋下重複。"""
    tj, _ = _fresh(tmp_path / "j.db")
    now_ms = int(time.time() * 1000)

    # 先以「帶序號」的 id 入帳（模擬 callback 有 exchange_seq）
    assert tj.insert_fill({
        "id": "A1#SEQ99", "ts": now_ms, "symbol": "TXFR1", "action": "Buy",
        "price": 17050, "qty": 2, "order_id": "A1", "raw": "",
    }) is True

    # 對帳路徑缺序號 → 退回內容鍵，id 不同，但 order_id+price+qty 近接時窗 → 擋下
    assert tj.insert_fill({
        "id": "A1#17050.000000#2#2", "ts": now_ms + 500, "symbol": "TXFR1",
        "action": "Buy", "price": 17050, "qty": 2, "order_id": "A1", "raw": "",
    }) is False
    assert len(tj.fetch_fills(limit=10)) == 1


def test_distinct_deals_with_seq_are_both_kept(tmp_path):
    """有序號的兩筆不同成交（同單多筆部分成交）不可被誤併。"""
    tj, osync = _fresh(tmp_path / "j.db")
    trade = _fake_trade("B7", "MXFR1", "Sell", [
        _deal(17000, 1, seq="S1"),
        _deal(17010, 1, seq="S2"),
    ])
    fills = osync.extract_deal_fills([trade])
    assert [f["id"] for f in fills] == ["B7#S1", "B7#S2"]
    n = sum(1 for f in fills if tj.insert_fill(f))
    assert n == 2
    assert len(tj.fetch_fills(limit=10)) == 2


def test_same_price_seq_partials_not_over_deduped(tmp_path):
    """★ 內容防重不得誤殺：同單、同價、同量、近接時窗、但**各有交易所序號**
    的兩筆真實部分成交必須都保留。"""
    tj, osync = _fresh(tmp_path / "j.db")
    now_ms = int(time.time() * 1000)
    trade = _fake_trade("C9", "TXFR1", "Buy", [
        _deal(17000, 1, seq="D1", ts=now_ms),
        _deal(17000, 1, seq="D2", ts=now_ms + 50),   # 同價同量、50ms 內
    ])
    fills = osync.extract_deal_fills([trade])
    assert [f["id"] for f in fills] == ["C9#D1", "C9#D2"]
    n = sum(1 for f in fills if tj.insert_fill(f))
    assert n == 2                                    # 兩筆皆保留
    assert len(tj.fetch_fills(limit=10)) == 2
