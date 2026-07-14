"""
test_audit_log.py — WS4 委託生命週期審計軌

自帶 DB 隔離（指向 tmp 檔）與連線重置，不依賴 conftest 的任何 fixture。
驗證：record / query round-trip、meta JSON 往返、order_trail 依時間正序、
event/symbol/order_id 過濾、risk_block 帶原因。
"""
import os
import sys
import importlib

import pytest

# 自帶 sys.path（不依賴 conftest）
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


@pytest.fixture()
def audit(tmp_path):
    """把 audit DB 指到 tmp 檔並重置快取連線；用完還原。"""
    from backend.services import audit_log as al
    old_env = os.environ.get("LIGHTRADE_AUDIT_DB")
    os.environ["LIGHTRADE_AUDIT_DB"] = str(tmp_path / "audit_test.db")
    al._reset_for_tests()
    try:
        yield al
    finally:
        al._reset_for_tests()
        if old_env is None:
            os.environ.pop("LIGHTRADE_AUDIT_DB", None)
        else:
            os.environ["LIGHTRADE_AUDIT_DB"] = old_env


def test_record_returns_rowid_and_query_roundtrip(audit):
    rid = audit.record(
        audit.EVENT_INTENT,
        order_id="ORD1", symbol="TXFR1", action="Buy", qty=2, price=17000.0,
        meta={"src": "manual"},
    )
    assert isinstance(rid, int) and rid > 0

    rows = audit.query(order_id="ORD1")
    assert len(rows) == 1
    r = rows[0]
    assert r["event_type"] == "intent"
    assert r["symbol"] == "TXFR1"
    assert r["action"] == "Buy"
    assert r["qty"] == 2
    assert r["price"] == 17000.0
    # meta 反序列化回 dict
    assert r["meta"] == {"src": "manual"}


def test_intent_before_order_id_is_allowed(audit):
    # 下單前（intent/risk_*）order_id 可為 None
    rid = audit.record(audit.EVENT_INTENT, symbol="MXFR1", action="Sell", qty=1, price=17010.0)
    assert rid > 0
    rows = audit.query(symbol="MXFR1")
    assert len(rows) == 1
    assert rows[0]["order_id"] is None


def test_order_trail_is_chronological(audit):
    # 一筆單完整生命週期，插入順序即時間序（ts 毫秒遞增靠 record 內部時間）
    for ev in ("intent", "risk_pass", "sent", "ack", "fill"):
        audit.record(ev, order_id="ORD9", symbol="TXFR1", action="Buy", qty=1, price=17000.0)
    trail = audit.order_trail("ORD9")
    assert [r["event_type"] for r in trail] == ["intent", "risk_pass", "sent", "ack", "fill"]
    # id 單調遞增 → 正序穩定（即使同毫秒也靠 id 次序）
    assert trail == sorted(trail, key=lambda r: (r["ts"], r["id"]))


def test_risk_block_carries_reason(audit):
    audit.record(
        audit.EVENT_RISK_BLOCK,
        order_id=None, symbol="TXFR1", action="Buy", qty=3, price=17000.0,
        meta={"reason": "daily_loss_limit", "limit": -50000, "current": -52000},
    )
    blocks = audit.query(event_type="risk_block")
    assert len(blocks) == 1
    assert blocks[0]["meta"]["reason"] == "daily_loss_limit"


def test_event_and_symbol_filters(audit):
    audit.record("fill", order_id="A", symbol="TXFR1", action="Buy", qty=1, price=1.0)
    audit.record("fill", order_id="B", symbol="MXFR1", action="Buy", qty=1, price=1.0)
    audit.record("cancel", order_id="A", symbol="TXFR1", action="Buy", qty=1, price=1.0)

    assert len(audit.query(event_type="fill")) == 2
    assert len(audit.query(symbol="MXFR1")) == 1
    assert len(audit.query(event_type="fill", symbol="TXFR1")) == 1
    assert len(audit.query()) == 3  # 無過濾 → 全部


def test_query_default_is_newest_first(audit):
    audit.record("intent", order_id="X1", symbol="TXFR1")
    audit.record("intent", order_id="X2", symbol="TXFR1")
    rows = audit.query(symbol="TXFR1")
    # 預設新→舊
    assert rows[0]["order_id"] == "X2"
    assert rows[1]["order_id"] == "X1"


def test_record_never_raises_on_bad_meta(audit):
    # 不可 JSON 序列化的物件也不能讓 record 拋（稽核落地失敗不得擋下單）
    class Unserializable:
        pass
    rid = audit.record("sent", order_id="Z", meta={"obj": Unserializable()})
    assert isinstance(rid, int) and rid > 0
    rows = audit.query(order_id="Z")
    assert len(rows) == 1  # 仍落地成功（default=str 兜底）
