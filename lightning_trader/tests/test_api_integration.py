"""
API 整合測試 — FastAPI TestClient + fake shioaji

驗證這次架構修復的核心行為（之前全部沒有 endpoint 級測試）：
  1. 市價單 → 409 CONFIRM_REQUIRED → confirm=true 重送成功
  2. 風控停止交易 → place_order / update_order 422 RISK_BLOCK
  3. 股票 flatten 真的送得出去（StockOrderLot NameError 回歸）
  4. reverse 過 RiskManager（超過部位上限被擋）
  5. 智慧單觸發過風控：開倉性觸發在熔斷後被擋；保護性（停損平倉）永遠放行
  6. pnl 餵入 → 日虧損熔斷真的會觸發
  7. journal fills → 日已實現損益餵入 RiskManager
  8. LIGHTRADE_API_TOKEN 認證（最後執行，會 reload main）
"""
import os
import sys
import time
import tempfile

# ── 必須在 import backend / core 之前 ──
_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

import fake_shioaji  # noqa: E402
fake_shioaji.install()

_TMP = tempfile.mkdtemp(prefix="lightrade-test-")
os.environ["LIGHTRADE_LOG_DIR"] = ""                                 # 不寫 log 檔
os.environ["LIGHTRADE_SMART_ORDERS_DB"] = os.path.join(_TMP, "smart.db")
os.environ["LIGHTRADE_JOURNAL_DB"] = os.path.join(_TMP, "journal.db")
os.environ.pop("LIGHTRADE_API_TOKEN", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import main as backend_main  # noqa: E402
from backend import shared  # noqa: E402
from backend import rate_limit  # noqa: E402
from fake_shioaji import Action, FakePosition  # noqa: E402

client = TestClient(backend_main.app)


def _fake_api():
    return shared.shioaji_client.api


def _rm():
    return shared.engine.risk_manager


@pytest.fixture(autouse=True)
def _reset_state():
    """每個測試前重置：登入狀態、風控、rate limit、假下單紀錄。"""
    sj_client = shared.shioaji_client
    sj_client._is_connected = True
    sj_client.active_stock_account = _fake_api()._accounts[0]
    sj_client.active_futopt_account = _fake_api()._accounts[1]
    _fake_api().positions = []
    _fake_api().placed_orders.clear()
    rm = _rm()
    rm.reset_daily()
    rm.update_config(max_position_per_symbol=10, max_daily_loss=-50000.0)
    rm._current_positions.clear()
    rm._current_prices.clear()
    rate_limit._buckets.clear()
    yield


def _wait_for(cond, timeout=3.0):
    """等 broker thread 上的智慧單觸發完成。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


# ─── 1. confirm 流程 ────────────────────────────────────────

def test_market_order_requires_confirm_then_succeeds():
    payload = {"symbol": "2330", "price": 0, "action": "Buy", "qty": 1,
               "price_type": "MKT"}
    r = client.post("/api/place_order", json=payload)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "CONFIRM_REQUIRED"
    assert detail["warnings"]
    assert not _fake_api().placed_orders  # 未確認前不能送單

    r2 = client.post("/api/place_order", json={**payload, "confirm": True})
    assert r2.status_code == 200, r2.text
    assert len(_fake_api().placed_orders) == 1
    sent = _fake_api().placed_orders[0]
    assert sent["code"] == "2330"
    assert sent["qty"] == 1


def test_limit_order_passes_without_confirm():
    r = client.post("/api/place_order", json={
        "symbol": "2330", "price": 500.0, "action": "Buy", "qty": 1,
        "price_type": "LMT",
    })
    assert r.status_code == 200, r.text
    assert _fake_api().placed_orders[0]["price"] == 500.0


# ─── 2. 風控封鎖 ────────────────────────────────────────────

def test_trading_disabled_blocks_place_and_update():
    _rm().config.trading_enabled = False
    r = client.post("/api/place_order", json={
        "symbol": "2330", "price": 500.0, "action": "Buy", "qty": 1,
    })
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "RISK_BLOCK"

    r2 = client.post("/api/update_order", json={
        "symbol": "2330", "action": "Buy", "old_price": 500.0, "new_price": 501.0,
    })
    assert r2.status_code == 422
    assert r2.json()["detail"]["code"] == "RISK_BLOCK"
    assert not _fake_api().placed_orders


def test_position_cap_blocks_order():
    _rm().update_config(max_position_per_symbol=3)
    r = client.post("/api/place_order", json={
        "symbol": "2330", "price": 500.0, "action": "Buy", "qty": 4,
    })
    assert r.status_code == 422
    assert "部位上限" in r.json()["detail"]["user_msg"]


# ─── 3. flatten（NameError 回歸） ───────────────────────────

def test_flatten_stock_position_sends_market_order():
    """股票平倉走 client.place_order 預設 StockOrderLot —— 修復前直接 NameError。"""
    _fake_api().positions = [FakePosition("2330", 3, Action.Buy)]
    r = client.post("/api/flatten", json={"symbol": "2330"})
    assert r.status_code == 200, r.text
    assert len(_fake_api().placed_orders) == 1
    sent = _fake_api().placed_orders[0]
    assert sent["code"] == "2330"
    assert sent["qty"] == 3
    assert "Sell" in sent["action"]
    assert sent["price"] == 0  # 市價


# ─── 4. reverse 過風控 ──────────────────────────────────────

def test_reverse_blocked_when_exceeding_position_cap():
    _rm().update_config(max_position_per_symbol=5)
    _fake_api().positions = [FakePosition("2330", 6, Action.Buy)]
    r = client.post("/api/reverse", json={"symbol": "2330"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "RISK_BLOCK"
    assert not _fake_api().placed_orders


def test_reverse_within_cap_succeeds():
    _fake_api().positions = [FakePosition("2330", 2, Action.Buy)]
    r = client.post("/api/reverse", json={"symbol": "2330"})
    assert r.status_code == 200, r.text
    assert _fake_api().placed_orders[0]["qty"] == 4  # 2 倍口數


# ─── 5. 智慧單觸發風控 ──────────────────────────────────────

def test_smart_entry_trigger_blocked_after_halt():
    """開倉性 MIT（無部位）在風控停止交易後觸發 → 不送單。"""
    r = client.post("/api/smart_orders", json={
        "symbol": "2330", "action": "Buy", "qty": 1,
        "order_type": "MIT", "trigger_price": 100, "trigger_condition": ">=",
    })
    assert r.status_code == 200, r.text
    _rm().config.trading_enabled = False

    shared.engine.event_bus.on_tick.emit("2330", {"Price": 101})
    assert not _wait_for(lambda: _fake_api().placed_orders, timeout=1.0)
    # 該單已消耗（觸發過）但被風控擋下
    assert shared.engine.smart_order_engine.get_active_orders("2330") == []


def test_smart_protective_trigger_fires_even_after_halt():
    """保護性停損（平既有多單）即使熔斷後也必須能執行。"""
    _fake_api().positions = [FakePosition("2330", 2, Action.Buy, price=100.0)]
    r = client.post("/api/smart_orders", json={
        "symbol": "2330", "action": "Sell", "qty": 2,
        "order_type": "STOP", "trigger_price": 95, "trigger_condition": "<=",
    })
    assert r.status_code == 200, r.text
    _rm().config.trading_enabled = False

    shared.engine.event_bus.on_tick.emit("2330", {"Price": 94})
    assert _wait_for(lambda: _fake_api().placed_orders), "保護性停損被錯誤攔下"
    sent = _fake_api().placed_orders[0]
    assert sent["qty"] == 2 and "Sell" in sent["action"] and sent["price"] == 0


# ─── 6. 日虧損熔斷（unrealized 餵入路徑） ───────────────────

def test_unrealized_feed_trips_daily_loss_halt():
    from backend.services import pnl_broadcaster as pb
    _rm().update_config(max_daily_loss=-1000.0)
    assert _rm().config.trading_enabled
    pb._feed_risk_manager({"positions": [], "total_pnl": -2000})
    assert _rm().config.trading_enabled is False


# ─── 7. journal → 日已實現損益 ──────────────────────────────

def test_realized_feed_from_journal():
    from backend.services import trade_journal, order_guard
    trade_journal.record_trade({"code": "2330", "action": "Buy", "price": 100.0,
                                "qty": 1, "ordno": "T1", "state": "deal"})
    trade_journal.record_trade({"code": "2330", "action": "Sell", "price": 90.0,
                                "qty": 1, "ordno": "T2", "state": "deal"})
    order_guard.refresh_daily_realized()
    # (90-100) × 1 張 × 1000 股 = -10000
    assert _rm()._daily_realized_pnl == -10000


# ─── 8. API Token 認證（最後執行：會 reload main） ──────────

def test_zz_api_token_auth():
    import importlib
    os.environ["LIGHTRADE_API_TOKEN"] = "test-token-123"
    try:
        m = importlib.reload(backend_main)
        c = TestClient(m.app)

        # health 豁免
        assert c.get("/api/health").status_code == 200
        # 無 token → 401
        assert c.get("/api/positions").status_code == 401
        # 錯 token → 401
        assert c.get("/api/positions",
                     headers={"X-API-Token": "wrong"}).status_code == 401
        # 對 token → 放行
        assert c.get("/api/positions",
                     headers={"X-API-Token": "test-token-123"}).status_code == 200

        # WebSocket：帶對 token 才握手成功
        with c.websocket_connect("/ws/quotes?token=test-token-123") as ws:
            ws.send_text('{"action":"subscribe","symbol":"2330"}')
            msg = ws.receive_json()
            assert msg["status"] in ("success", "error")  # 未登入回 error，但代表已通過認證
    finally:
        os.environ.pop("LIGHTRADE_API_TOKEN", None)
