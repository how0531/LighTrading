"""
CHASE 追價單 × 撤單非同步 × 在途成交 —— 端到端不超額整合測試（F8）

覆蓋 P0-1 生產路徑最關鍵的不變量：CHASE cancel-replace 改價時，舊腿可能在
「撤單在途」窗口於交易所端先部分成交；引擎必須先確認撤單終態 + 讀回實際
累計成交量，再以「真實剩量」掛新腿，否則會超額建倉（活躍量 + 已成量 > 委託量）。

既有 test_api_integration 的 test_confirm_order_cancelled_reports_inflight_fill
只在 ShioajiClient 單元層驗證 confirm 的回報；本檔補上「經 /api/smart_orders
建 CHASE → bidask 觸發改價 → 走 order executor 上 cancel-replace」的完整鏈路，
證明剩量真的沿著引擎流回新腿的下單量。

用到 fake_shioaji 的既有能力：async_cancel（撤單非同步）、cancel_race_hook
（撤單送出當下舊腿成交）、flush_cancels_on_status（撤單終態在下次
update_status 到達，讓 confirm_order_cancelled 的輪詢自然收斂）。
"""
import os
import sys
import time
import tempfile

# ── 必須在 import backend / core 之前（與 test_api_integration 同步佈置） ──
_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

import fake_shioaji  # noqa: E402
fake_shioaji.install()

_TMP = tempfile.mkdtemp(prefix="lightrade-chase-test-")
os.environ.setdefault("LIGHTRADE_LOG_DIR", "")
os.environ.setdefault("LIGHTRADE_SMART_ORDERS_DB", os.path.join(_TMP, "smart.db"))
os.environ.setdefault("LIGHTRADE_JOURNAL_DB", os.path.join(_TMP, "journal.db"))
os.environ.pop("LIGHTRADE_API_TOKEN", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import main as backend_main  # noqa: E402
from backend import shared  # noqa: E402
from fake_shioaji import Action  # noqa: E402

client = TestClient(backend_main.app)


def _fake_api():
    return shared.shioaji_client.api


def _rm():
    return shared.engine.risk_manager


def _emit_bidask(symbol, bid, ask):
    """餵一筆最佳一檔五檔（與 bridge 發射點同格式）。"""
    shared.engine.event_bus.on_bidask.emit(symbol, {
        "Symbol": symbol, "BidPrice": [bid], "AskPrice": [ask],
        "BidVolume": [10], "AskVolume": [10],
    })


def _wait_for(cond, timeout=3.0):
    """等 order executor 上的追價 cancel-replace 落地。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


@pytest.fixture(autouse=True)
def _reset_state():
    """每測試前重置：登入狀態、風控、假下單紀錄、CHASE 引擎、fake 競速旗標。"""
    sj = shared.shioaji_client
    sj._is_connected = True
    api = _fake_api()
    sj.active_stock_account = api._accounts[0]
    sj.active_futopt_account = api._accounts[1]

    eng = getattr(shared.engine, "smart_order_engine", None)
    if eng is not None:
        eng.cancel_all()
    # 抽乾背景 executor：確保前一測試 dispatch 的撤單/下單都落地後再 clear
    for ex in (shared.broker_executor, shared.order_executor, shared.sync_executor):
        try:
            ex.submit(lambda: None).result(timeout=5)
        except Exception:
            pass

    api.positions = []
    api.trades = []
    api.placed_orders.clear()
    api.cancelled_orders.clear()
    # fake 的可選競速行為一律回預設（同步撤單），避免污染其他測試
    api.async_cancel = False
    api.flush_cancels_on_status = False
    api.cancel_race_hook = None
    api._pending_cancels.clear()

    rm = _rm()
    rm.reset_daily()
    rm.update_config(max_position_per_symbol=10, max_daily_loss=-50000.0)
    rm._current_positions.clear()
    rm._current_prices.clear()
    yield


def test_chase_reprice_inflight_fill_places_true_remaining_no_overfill():
    """撤單在途成交 → 改價新腿只掛真實剩量，不超額。

    劇本（CHASE Buy 3）：
      1. 進場腿以最佳對手價 501 掛 3 口。
      2. 賣一 501 → 502（1 tick 不利）觸發改價：
         - 撤舊腿；撤單「送出當下」舊腿在交易所端成交 2 口（撤單在途競速）。
         - 撤單非同步生效，剩 1 口 → Cancelled。
         - confirm_order_cancelled 讀回實際已成 2 口。
      3. 引擎以真實剩量 (3 - 2 = 1) 掛新腿於 502，而非盲送原始 3 口。

    不變量：活躍(新掛)量 + 已成量 == 委託量（== 3），任一環節誤用 remaining
    都會讓新腿掛 3 口 → 活躍 3 + 已成 2 = 5 > 3（超額建倉）。
    """
    api = _fake_api()

    # 1. 建 CHASE Buy 3 → 進場腿掛賣一 501 x3
    _emit_bidask("2330", 500.0, 501.0)
    r = client.post("/api/smart_orders", json={
        "order_type": "CHASE", "symbol": "2330", "action": "Buy", "quantity": 3,
    })
    assert r.status_code == 200, r.text
    oid = r.json()["id"]
    assert len(api.placed_orders) == 1
    assert api.placed_orders[0]["qty"] == 3
    assert api.placed_orders[0]["price"] == 501.0

    # 2. 佈置「撤單在途競速」：非同步撤單 + 撤單送出當下舊腿先成交 2 口，
    #    撤單終態在下次 update_status（confirm 輪詢）到達。
    api.async_cancel = True
    api.flush_cancels_on_status = True
    api.cancel_race_hook = lambda t: api.fill_trade(t, 2, 501.0, "rd1")

    # 3. 賣一 501 → 502 觸發改價（第一次改價不受 interval 限制）
    _emit_bidask("2330", 501.0, 502.0)
    assert _wait_for(lambda: len(api.placed_orders) == 2), "改價新腿未送出"

    new_leg = api.placed_orders[1]
    # ★ 不超額核心：新腿只掛真實剩量 1（非原始 3），價格為新最佳對手價 502
    assert new_leg["qty"] == 1, f"新腿超額掛 {new_leg['qty']} 口（真實剩量應為 1）"
    assert new_leg["price"] == 502.0

    chase = next(o for o in client.get("/api/smart_orders").json()
                 if o["id"] == oid)
    assert chase["filled_qty"] == 2          # 撤單在途成交 2 口被 confirm 讀回
    assert chase["remaining_qty"] == 1
    assert chase["reprice_count"] == 1
    assert chase["chase_price"] == 502.0
    assert chase["chase_status"] == "CHASING"

    # ★ 不變量：活躍(新掛)量 + 已成量 == 原始委託量（== 3）
    assert new_leg["qty"] + chase["filled_qty"] == chase["qty"] == 3

    # 舊腿確實被撤（在途 → Cancelled），且只撤一張
    assert _wait_for(lambda: len(api.cancelled_orders) >= 1), "舊腿未被撤"
