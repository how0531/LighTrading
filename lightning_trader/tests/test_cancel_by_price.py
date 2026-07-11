"""
/api/cancel_all 的「精確價位撤單」分支整合測試（P0-2）

驗證共享契約：
  - price 有值 → 只撤該 symbol/action/price 的委託（cancel_orders_by_action_price），
    不誤刪同側其他價位（含手動單）；回傳 cancelled = 實際撤單數。
  - price 為 None → 維持整側撤單（cancel_all）。
  - price 指定但該價位已無委託 → cancelled=0（據實回報，不灌水）。

只對 fake_shioaji 驗證（cancel_orders_by_action_price 走 list_trades()+cancel_order，
fake 皆支援）；不動 fake_shioaji / core.shioaji_client。
"""
import os
import sys
import tempfile

_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

import fake_shioaji  # noqa: E402
fake_shioaji.install()

_TMP = tempfile.mkdtemp(prefix="lightrade-cancelbyprice-")
os.environ.setdefault("LIGHTRADE_LOG_DIR", "")
os.environ.setdefault("LIGHTRADE_SMART_ORDERS_DB", os.path.join(_TMP, "smart.db"))
os.environ.setdefault("LIGHTRADE_JOURNAL_DB", os.path.join(_TMP, "journal.db"))
os.environ.pop("LIGHTRADE_API_TOKEN", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import main as backend_main  # noqa: E402
from backend import shared  # noqa: E402
from fake_shioaji import Action, make_trade  # noqa: E402

client = TestClient(backend_main.app)


def _fake_api():
    return shared.shioaji_client.api


@pytest.fixture(autouse=True)
def _reset_state():
    sj = shared.shioaji_client
    sj._is_connected = True
    sj.active_stock_account = _fake_api()._accounts[0]
    sj.active_futopt_account = _fake_api()._accounts[1]
    _fake_api().trades = []
    _fake_api().placed_orders.clear()
    _fake_api().cancelled_orders.clear()
    yield


def _active(trade) -> bool:
    return trade.status.status.name in ("PendingSubmit", "PreSubmitted", "Submitted")


def test_cancel_by_price_only_targets_that_level():
    # 同側三檔委託：買 @500 / @500（兩張同價）/ @501；外加賣 @500
    _fake_api().trades = [
        make_trade("2330", Action.Buy, 500.0, 1, ordno="B1"),
        make_trade("2330", Action.Buy, 500.0, 2, ordno="B2"),
        make_trade("2330", Action.Buy, 501.0, 1, ordno="B3"),
        make_trade("2330", Action.Sell, 500.0, 1, ordno="S1"),
    ]

    r = client.post("/api/cancel_all", json={"symbol": "2330", "action": "Buy", "price": 500.0})
    assert r.status_code == 200, r.text
    body = r.json()
    # 精確價位撤單：只撤買 @500 的兩張
    assert body["cancelled"] == 2

    trades = {t.order.ordno: t for t in _fake_api().trades}
    assert not _active(trades["B1"])   # 撤掉
    assert not _active(trades["B2"])   # 撤掉
    assert _active(trades["B3"])       # 別的價位不動
    assert _active(trades["S1"])       # 別側不動


def test_cancel_all_without_price_cancels_whole_side():
    _fake_api().trades = [
        make_trade("2330", Action.Buy, 500.0, 1, ordno="B1"),
        make_trade("2330", Action.Buy, 501.0, 1, ordno="B2"),
        make_trade("2330", Action.Sell, 500.0, 1, ordno="S1"),
    ]

    r = client.post("/api/cancel_all", json={"symbol": "2330", "action": "Buy"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cancelled"] == 2  # 整個買側

    trades = {t.order.ordno: t for t in _fake_api().trades}
    assert not _active(trades["B1"])
    assert not _active(trades["B2"])
    assert _active(trades["S1"])  # 賣側不動


def test_cancel_by_price_no_match_reports_zero():
    _fake_api().trades = [
        make_trade("2330", Action.Buy, 500.0, 1, ordno="B1"),
    ]
    # 該價位沒有委託（已成交/已撤情境）→ cancelled=0，據實回報
    r = client.post("/api/cancel_all", json={"symbol": "2330", "action": "Buy", "price": 499.0})
    assert r.status_code == 200, r.text
    assert r.json()["cancelled"] == 0
    # 原委託不受影響
    assert _active(_fake_api().trades[0])
