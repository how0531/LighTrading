"""
啟動對帳協議（WS3，保守安全版）整合測試

覆蓋 backend/services/reconciliation.py 的核心不變量：
  - 券商與我方一致 → 無落差、無告警、不動 trading_enabled
  - store 有殭屍智慧單（active CHASE、券商查無對應活躍委託）→ 偵測 + audit +
    交回既有引擎 sync_broker_orders 處理
  - 券商有倉、我方 journal 對不上 → 告警 + audit（no_local_record 落差）
  - HALT 旗標：LIGHTRADE_RECON_HALT_ON_DIVERGENCE=true → 停用交易；
    預設 False → 只告警不停（比照 WS1 安全預設）
  - 對帳任一環節例外 → 不擋啟動（best-effort，回傳報告而非拋出）

沿用 tests/conftest.py 的 reset_backend_state autouse fixture 做隔離。
"""
import asyncio
import os
import sys
import tempfile

# ── 必須在 import backend / core 之前（與其他整合測試同步佈置） ──
_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

import fake_shioaji  # noqa: E402
fake_shioaji.install()

_TMP = tempfile.mkdtemp(prefix="lightrade-recon-test-")
os.environ.setdefault("LIGHTRADE_LOG_DIR", "")
os.environ.setdefault("LIGHTRADE_SMART_ORDERS_DB", os.path.join(_TMP, "smart.db"))
os.environ.setdefault("LIGHTRADE_JOURNAL_DB", os.path.join(_TMP, "journal.db"))
os.environ.setdefault("LIGHTRADE_AUDIT_DB", os.path.join(_TMP, "audit.db"))
os.environ.pop("LIGHTRADE_API_TOKEN", None)
os.environ.pop("LIGHTRADE_RECON_HALT_ON_DIVERGENCE", None)

import pytest  # noqa: E402

from backend import main as backend_main  # noqa: E402  (建立 engine / wire callbacks)
from backend import shared  # noqa: E402
from backend.services import reconciliation, trade_journal, audit_log  # noqa: E402
from fake_shioaji import Action, FakePosition  # noqa: E402


def _api():
    return shared.shioaji_client.api


def _soe():
    return shared.engine.smart_order_engine


def _rm():
    return shared.engine.risk_manager


def _emit_bidask(symbol, bid, ask):
    shared.engine.event_bus.on_bidask.emit(symbol, {
        "Symbol": symbol, "BidPrice": [bid], "AskPrice": [ask],
        "BidVolume": [10], "AskVolume": [10],
    })


def _insert_fill(fill_id, symbol, action, price, qty, order_id="OX"):
    assert trade_journal.insert_fill({
        "id": fill_id, "ts": 1_000, "symbol": symbol, "action": action,
        "price": price, "qty": qty, "order_id": order_id, "raw": "",
    })


@pytest.fixture
def alerts():
    """收集本次測試期間 on_risk_breach 發出的告警，測試後移除 handler。"""
    captured = []

    def _h(level, message):
        captured.append((level, message))

    bus = shared.engine.event_bus
    bus.on_risk_breach.connect(_h)
    try:
        yield captured
    finally:
        bus.on_risk_breach.disconnect(_h)


@pytest.fixture(autouse=True)
def _clean_halt_env():
    """每測試前確保 HALT 旗標未殘留（其他測試可能 setenv）。"""
    os.environ.pop("LIGHTRADE_RECON_HALT_ON_DIVERGENCE", None)
    yield
    os.environ.pop("LIGHTRADE_RECON_HALT_ON_DIVERGENCE", None)


# ─────────────────────────────────────────────────────────────

def test_consistent_broker_and_local_no_alert(alerts):
    """券商持倉與我方 journal 淨口數一致、無殭屍 → 無落差、無告警、不停交易。"""
    # journal：買 2330 x3 → 淨 +3
    _insert_fill("f1", "2330", "Buy", 500.0, 3)
    # 券商持倉：2330 Buy 3 → 淨 +3（一致）
    _api().positions = [FakePosition("2330", 3, Action.Buy, price=500.0)]

    report = asyncio.run(reconciliation.reconcile_on_startup())

    assert report["ran"] is True
    assert report["snapshot_complete"] is True
    assert report["divergence_count"] == 0
    assert report["positions"]["divergences"] == []
    assert report["smart_orders"]["zombies"] == []
    assert report["halted"] is False
    assert alerts == []                       # 一致 → 完全不告警
    assert _rm().config.trading_enabled is True


def test_broker_position_no_local_record_alerts(alerts):
    """券商有倉、我方 journal 完全對不上 → no_local_record 落差 + 告警 + audit。
    HALT 預設 False → 只告警不停用交易。"""
    _api().positions = [FakePosition("2890", 5, Action.Sell, price=30.0)]

    report = asyncio.run(reconciliation.reconcile_on_startup())

    divs = report["positions"]["divergences"]
    assert len(divs) == 1
    d = divs[0]
    assert d["symbol"] == "2890"
    assert d["broker_net"] == -5             # Sell 5 → 淨 -5
    assert d["local_net"] == 0
    assert d["reason"] == "no_local_record"
    assert report["divergence_count"] == 1

    # 告警發出（block 級）
    assert any(lvl == "block" and "2890" in msg for lvl, msg in alerts)
    # audit 留痕
    trail = audit_log.query(event_type="recon_position_divergence", symbol="2890", limit=10)
    assert any(r["symbol"] == "2890" for r in trail)

    # HALT 預設 False → 不停交易
    assert report["halted"] is False
    assert _rm().config.trading_enabled is True


def test_halt_flag_disables_trading_on_divergence(alerts, monkeypatch):
    """LIGHTRADE_RECON_HALT_ON_DIVERGENCE=true + 有落差 → 停用交易（fail-safe）。"""
    monkeypatch.setenv("LIGHTRADE_RECON_HALT_ON_DIVERGENCE", "true")
    _api().positions = [FakePosition("2890", 5, Action.Sell, price=30.0)]

    assert _rm().config.trading_enabled is True
    report = asyncio.run(reconciliation.reconcile_on_startup())

    assert report["divergence_count"] == 1
    assert report["halted"] is True
    assert _rm().config.trading_enabled is False          # 已 fail-safe 停用
    assert any("trading_enabled=False" in msg for _, msg in alerts)
    assert audit_log.query(event_type="recon_halt", limit=5)


def test_halt_flag_default_false_does_not_disable(alerts):
    """未設 HALT 旗標（預設 False）+ 有落差 → 不停用交易，只告警。"""
    _api().positions = [FakePosition("2890", 5, Action.Sell, price=30.0)]

    report = asyncio.run(reconciliation.reconcile_on_startup())

    assert report["divergence_count"] == 1
    assert report["halted"] is False
    assert _rm().config.trading_enabled is True


def test_zombie_smart_order_detected_and_engine_invoked(alerts):
    """store 有 active CHASE、券商查無對應活躍委託 → 偵測殭屍 + audit +
    呼叫既有引擎 sync_broker_orders 處理。"""
    # 建一張真的 CHASE（會下單、進 api.trades），再清空 api.trades 模擬
    # 「重啟後 store 仍 active 但券商端已無此掛單」。
    _emit_bidask("2330", 500.0, 501.0)
    order = _soe().add_chase("2330", "Buy", 1)
    assert order is not None and order.chase_status == "CHASING"
    oid = order.id
    assert order.broker_order_ids                       # 有券商掛單編號

    # 模擬券商端已無此委託
    _api().trades = []

    # spy：包住 sync_broker_orders 確認被呼叫（仍執行真實處理）
    soe = _soe()
    called = {"n": 0}
    orig = soe.sync_broker_orders

    def _spy(*a, **k):
        called["n"] += 1
        return orig(*a, **k)

    soe.sync_broker_orders = _spy
    try:
        report = asyncio.run(reconciliation.reconcile_on_startup())
    finally:
        soe.sync_broker_orders = orig

    assert oid in report["smart_orders"]["zombies"]
    assert report["smart_orders"]["zombies"]            # 非空
    assert called["n"] >= 1                             # 交回既有引擎處理
    # 告警 + audit 留痕
    assert any(lvl == "block" and oid in msg for lvl, msg in alerts)
    trail = audit_log.query(event_type="recon_zombie_smart_order", order_id=oid, limit=10)
    assert any(r["order_id"] == oid for r in trail)


def test_matched_broker_order_not_flagged_zombie(alerts):
    """券商有對應活躍委託 → CHASE 不被誤判殭屍（matched）。"""
    _emit_bidask("2330", 500.0, 501.0)
    order = _soe().add_chase("2330", "Buy", 1)
    assert order is not None
    oid = order.id
    # 不清 api.trades：券商端仍有此活躍委託

    report = asyncio.run(reconciliation.reconcile_on_startup())

    assert oid not in report["smart_orders"]["zombies"]
    assert oid in report["smart_orders"]["matched"]
    assert report["divergence_count"] == 0
    assert not any(lvl == "block" for lvl, _ in alerts)


def test_incomplete_snapshot_does_not_flag_zombie(alerts):
    """快照不完整（update_status 失敗）→ 缺席不可信，不判殭屍（保守）。"""
    _emit_bidask("2330", 500.0, 501.0)
    order = _soe().add_chase("2330", "Buy", 1)
    oid = order.id
    _api().trades = []                                  # 券商端查無

    # 讓一個帳號 update_status 失敗 → snapshot_complete=False
    api = _api()
    orig_update = api.update_status

    def _flaky(acc=None, *a, **k):
        raise RuntimeError("update_status boom")

    api.update_status = _flaky
    try:
        report = asyncio.run(reconciliation.reconcile_on_startup())
    finally:
        api.update_status = orig_update

    assert report["snapshot_complete"] is False
    assert oid not in report["smart_orders"]["zombies"]  # 不完整快照 → 不判殭屍


def test_reconcile_exception_does_not_block_startup(monkeypatch):
    """對帳任一環節例外 → 吞掉並回報，不拋出（不擋 backend 啟動）。"""
    async def _boom(*a, **k):
        raise RuntimeError("broker snapshot down")

    monkeypatch.setattr(shared, "run_in_sync_thread", _boom)

    # 不應拋出
    report = asyncio.run(reconciliation.reconcile_on_startup())
    assert report.get("error")
    assert report["ran"] is False


def test_skipped_when_not_connected():
    """未登入券商 → 跳過對帳（不查、不告警）。"""
    shared.shioaji_client._is_connected = False
    try:
        report = asyncio.run(reconciliation.reconcile_on_startup())
    finally:
        shared.shioaji_client._is_connected = True
    assert report["ran"] is False
    assert report["skipped"] == "not_connected"
