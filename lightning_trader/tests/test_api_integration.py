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
from fake_shioaji import Action, FakePosition, QuoteType  # noqa: E402

client = TestClient(backend_main.app)


def _fake_api():
    return shared.shioaji_client.api


def _rm():
    return shared.engine.risk_manager


def _drain_executors():
    """抽乾三個單 worker executor：submit 哨兵並等它完成，FIFO 保證
    先前排入的背景工作（智慧單觸發的下單、cancel_all 的撤單、成交副作用
    排的重算）全部落地。避免前一測試遲到的 place_order 在下一測試
    clear 之後才寫進 placed_orders，造成 test_create_bracket_via_rest
    這類「多看到一筆」的 flaky。"""
    for ex in (shared.broker_executor, shared.order_executor, shared.sync_executor):
        try:
            ex.submit(lambda: None).result(timeout=5)
        except Exception:
            pass


@pytest.fixture(autouse=True)
def _reset_state():
    """每個測試前重置：登入狀態、風控、rate limit、假下單紀錄。"""
    sj_client = shared.shioaji_client
    sj_client._is_connected = True
    sj_client.active_stock_account = _fake_api()._accounts[0]
    sj_client.active_futopt_account = _fake_api()._accounts[1]
    eng = getattr(shared.engine, "smart_order_engine", None)
    if eng is not None:
        eng.cancel_all()
    # 先抽乾背景 executor，再清假下單紀錄 —— 順序關鍵：確保前一測試
    # 在背景執行緒上 dispatch 的下單/撤單都已落地後才 clear，之後不再有
    # 遲到的寫入污染下一測試。
    _drain_executors()
    _fake_api().positions = []
    _fake_api().trades = []
    _fake_api().placed_orders.clear()
    _fake_api().cancelled_orders.clear()
    rm = _rm()
    rm.reset_daily()
    rm.update_config(max_position_per_symbol=10, max_daily_loss=-50000.0)
    rm._current_positions.clear()
    rm._current_prices.clear()
    rate_limit._buckets.clear()
    # ── 對帳/去重的模組級單例也必須每測試重置，否則測試順序相依 ──
    # order_sync 的 in-memory watermark（_seen_fill_ids）跨測試累積 →
    # 同 id 的成交在後續測試被誤判「已處理」，new_fills 少算；更嚴重的是
    # 這層記憶體去重會遮蔽 insert_fill 對 journal DB 重複入帳的回歸。
    # _last_fingerprint 殘留 → WorkingOrdersSnapshot 的 changed 判定失準。
    import backend.services.order_sync as _os
    _os._seen_fill_ids.clear()
    _os._last_fingerprint = ""
    # journal 是全 session 共用同一個 SQLite 檔（_CONN 單例）——不清空 fills
    # 表，前一測試的成交會漏進下一測試的 FIFO 已實現損益重算，金額斷言
    # 變成順序相依。每測試清空 fills，讓已實現損益 / 去重回歸各自獨立。
    from backend.services import trade_journal as _tj
    try:
        with _tj._DB_LOCK:
            _tj._connect().execute("DELETE FROM fills")
    except Exception:
        pass
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


def test_flat_positions_zero_out_unrealized():
    """全部平倉後 payload 為空 → 未實現損益必須歸零，
    否則會與已實現重複計算、誤觸熔斷（審查發現 #0 的回歸）。"""
    from backend.services import pnl_broadcaster as pb
    rm = _rm()
    pb._feed_risk_manager({
        "positions": [{"symbol": "2330", "qty": 1, "direction": "Buy"}],
        "total_pnl": -2000,
    })
    assert rm._daily_unrealized_pnl == -2000
    assert rm._current_positions.get("2330") == 1
    pb._feed_risk_manager({"positions": [], "total_pnl": 0})
    assert rm._daily_unrealized_pnl == 0
    assert rm._current_positions == {}


# ─── 7. journal → 日已實現損益 ──────────────────────────────

def test_realized_feed_from_journal():
    from backend.services import trade_journal, order_guard
    # fixture 的 reset_daily() 已把 rm.last_reset_ms 設為「剛剛」，
    # refresh 的基線因此是 reset 時間點（決定性，不受 04:00/午夜邊界影響）
    trade_journal.record_trade({"code": "2330", "action": "Buy", "price": 100.0,
                                "qty": 1, "ordno": "T1", "state": "deal"})
    trade_journal.record_trade({"code": "2330", "action": "Sell", "price": 90.0,
                                "qty": 1, "ordno": "T2", "state": "deal"})
    order_guard.refresh_daily_realized()
    # (90-100) × 1 張 × 1000 股 = -10000
    assert _rm()._daily_realized_pnl == -10000


def test_realized_feed_matches_open_leg_before_boundary():
    """跨風控日邊界的回合（昨晚開倉、今日平倉）：FIFO 必須配對到邊界前的
    開倉腳，只把「邊界後的增量」算進本日（審查發現 #1 的回歸）。"""
    import time as _t
    from backend.services import trade_journal, order_guard
    rm = _rm()
    now_ms = int(_t.time() * 1000)
    # 開倉腳在「上一個風控日」（reset 前 2 小時），平倉腳在本日
    trade_journal.import_fills([
        {"ts": now_ms - 2 * 3600 * 1000, "symbol": "2890", "action": "Buy",
         "price": 100.0, "qty": 1, "order_id": "X1"},
    ])
    trade_journal.record_trade({"code": "2890", "action": "Sell", "price": 95.0,
                                "qty": 1, "ordno": "X2", "state": "deal"})
    order_guard.refresh_daily_realized()
    # 平倉腳正確配對到邊界前的開倉腳 → 本日增量 = (95-100)×1000 = -5000
    # （修復前：開倉腳被截掉 → 平倉被當成新開空單 → realized = 0）
    assert rm._daily_realized_pnl == -5000


def test_reduce_only_order_allowed_during_halt():
    """熔斷後手動下單面板必須仍能送出「平倉方向、不超過部位」的單——
    之前 pre_order_check 第 1 步無條件封鎖，使用者被鎖在虧損部位裡。"""
    _fake_api().positions = [FakePosition("2330", 2, Action.Buy, price=500.0)]
    _rm().config.trading_enabled = False

    # 平倉方向（Sell 2，不超過淨部位 2）→ 放行
    r = client.post("/api/place_order", json={
        "symbol": "2330", "price": 495.0, "action": "Sell", "qty": 2,
        "confirm": True,  # 反向確認 warning 已由使用者確認
    })
    assert r.status_code == 200, r.text
    assert len(_fake_api().placed_orders) == 1

    # 開倉方向（再買）→ 仍被熔斷擋下
    r2 = client.post("/api/place_order", json={
        "symbol": "2330", "price": 500.0, "action": "Buy", "qty": 1, "confirm": True,
    })
    assert r2.status_code == 422
    assert r2.json()["detail"]["code"] == "RISK_BLOCK"

    # 超過部位的反向單（Sell 5 > 淨 2）→ 也擋（那是反向開倉）
    r3 = client.post("/api/place_order", json={
        "symbol": "2330", "price": 495.0, "action": "Sell", "qty": 5, "confirm": True,
    })
    assert r3.status_code == 422


# ─── 8. 成交回報 → fill 管線（signal_trade_update 死線回歸） ─

def test_deal_callback_reaches_fill_pipeline():
    """券商 order callback 的 Deal 事件必須流進 on_fill / journal ——
    signal_trade_update 之前從來沒有人 emit，整條成交鏈是死的（審查發現 #6）。"""
    fills = []
    shared.engine.event_bus.on_fill.connect(fills.append)
    try:
        cb = _fake_api()._order_callback
        assert cb is not None, "order callback 未註冊"
        cb("OrderState.StockDeal", {"code": "2317", "action": "Buy",
                                    "price": 100.0, "quantity": 1, "ordno": "D1"})
        assert fills, "Deal 事件沒有流進 on_fill"
        assert fills[0]["symbol"] == "2317"
        assert fills[0]["qty"] == 1
    finally:
        shared.engine.event_bus.on_fill.disconnect(fills.append)


def test_callback_and_sync_fill_ids_dedupe():
    """同一筆成交走 callback（deal msg 有 exchange_seq）與對帳迴圈（Deal.seq）
    必須產生相同 id —— 之前 callback 落到時間戳 fallback，去重失效、
    成交重複入帳、日已實現損益翻倍。"""
    import asyncio
    from backend.services import order_sync, trade_journal
    from fake_shioaji import make_trade

    # 1. callback 路徑先記（Shioaji Deal msg 形狀：ordno + exchange_seq，無 dealseq/seq）
    cb = _fake_api()._order_callback
    cb("OrderState.StockDeal", {"code": "2330", "action": "Buy", "price": 100.0,
                                "quantity": 1, "ordno": "DUP1", "exchange_seq": "E77"})
    before = len(trade_journal.fetch_fills(symbol="2330", limit=50))

    # 2. 對帳迴圈看到同一筆成交（list_trades 的 Deal.seq == exchange_seq）
    _fake_api().trades = [
        make_trade("2330", Action.Buy, 100.0, 1, status="Filled", ordno="DUP1",
                   deals=[(100.0, 1, "E77", time.time())], filled_qty=1),
    ]
    order_sync._last_fingerprint = ""
    order_sync._seen_fill_ids.clear()
    result = asyncio.run(order_sync.sync_once())

    after = len(trade_journal.fetch_fills(symbol="2330", limit=50))
    assert result["new_fills"] == 0, "同一筆成交被重複入帳（id 分歧，去重失效）"
    assert after == before


def test_create_oco_via_rest():
    """OCO REST 路由 → 引擎掛出配對的停利/停損兩腿。"""
    eng = shared.engine.smart_order_engine
    r = client.post("/api/smart_orders", json={
        "symbol": "2330", "action": "Sell", "qty": 1,
        "order_type": "OCO", "take_profit_price": 550, "stop_loss_price": 500,
    })
    assert r.status_code == 200, r.text
    active = eng.get_active_orders("2330")
    oco = [o for o in active if o["order_type"] == "OCO"]
    assert len(oco) == 2
    # 一腿觸發（價 >= 550）→ 另一腿被連帶取消
    shared.engine.event_bus.on_tick.emit("2330", {"Price": 551})
    assert _wait_for(lambda: len(eng.get_active_orders("2330")) == 0)


def test_create_bracket_via_rest():
    """Bracket REST 路由 → 立即送出進場限價單。"""
    r = client.post("/api/smart_orders", json={
        "symbol": "2330", "action": "Buy", "qty": 1,
        "order_type": "BRACKET", "entry_price": 520,
        "take_profit_price": 550, "stop_loss_price": 500,
    })
    assert r.status_code == 200, r.text
    assert len(_fake_api().placed_orders) == 1  # 進場單已送
    assert _fake_api().placed_orders[0]["price"] == 520


def test_oco_bracket_reject_missing_prices():
    r1 = client.post("/api/smart_orders", json={
        "symbol": "2330", "action": "Sell", "qty": 1,
        "order_type": "OCO", "take_profit_price": 550,  # 缺 stop_loss
    })
    assert r1.status_code == 422 and r1.json()["detail"]["code"] == "INVALID_OCO"
    r2 = client.post("/api/smart_orders", json={
        "symbol": "2330", "action": "Buy", "qty": 1,
        "order_type": "BRACKET", "take_profit_price": 550, "stop_loss_price": 500,  # 缺 entry
    })
    assert r2.status_code == 422 and r2.json()["detail"]["code"] == "INVALID_BRACKET"


# ─── 9. 委託對帳迴圈（外部管道下單即時同步） ────────────────

def test_order_sync_pushes_external_orders_and_fills():
    """從其他管道（券商 App / 另一個 API session）下的單不會有 callback ——
    對帳迴圈必須：推播活躍委託快照 + 把外部成交補進 journal。"""
    import asyncio
    from backend.services import order_sync, trade_journal
    from fake_shioaji import make_trade

    _fake_api().trades = [
        # 外部掛的活躍委託
        make_trade("2330", Action.Buy, 500.0, 2, status="Submitted", ordno="EXT001"),
        # 外部已成交的單（帶一筆 deal）
        make_trade("2890", Action.Sell, 20.0, 1, status="Filled", ordno="EXT002",
                   deals=[(20.0, 1, "S1", time.time())], filled_qty=1),
    ]
    order_sync._last_fingerprint = ""
    while not shared.quotes_to_broadcast.empty():
        shared.quotes_to_broadcast.get_nowait()

    result = asyncio.run(order_sync.sync_once())
    assert result["changed"] is True
    assert result["new_fills"] == 1

    msgs = []
    while not shared.quotes_to_broadcast.empty():
        msgs.append(shared.quotes_to_broadcast.get_nowait())
    snap = next(m for m in msgs if m["type"] == "WorkingOrdersSnapshot")
    assert [o["symbol"] for o in snap["data"]["orders"]] == ["2330"]
    assert snap["data"]["orders"][0]["qty"] == 2
    assert snap["seq_no"] > 0
    assert any(m["type"] == "TradeUpdate" and m["data"].get("source") == "order_sync"
               for m in msgs)

    # 外部成交已入 journal（已實現損益 / 交易日誌不再漏算外部管道）
    fills = trade_journal.fetch_fills(symbol="2890", limit=10)
    assert any(f["order_id"] == "EXT002" for f in fills)

    # 同一狀態再跑一輪：無變化、無新成交（快照指紋 + journal id 去重）
    result2 = asyncio.run(order_sync.sync_once())
    assert result2 == {"changed": False, "new_fills": 0}


def test_order_sync_detects_cancellation_from_other_channel():
    """外部管道刪單後，快照變化也要推播（委託從畫面消失）。"""
    import asyncio
    from backend.services import order_sync
    from fake_shioaji import make_trade

    _fake_api().trades = [
        make_trade("2330", Action.Buy, 500.0, 2, status="Submitted", ordno="EXT010"),
    ]
    order_sync._last_fingerprint = ""
    asyncio.run(order_sync.sync_once())

    # 外部把單刪了
    _fake_api().trades = [
        make_trade("2330", Action.Buy, 500.0, 2, status="Cancelled", ordno="EXT010"),
    ]
    while not shared.quotes_to_broadcast.empty():
        shared.quotes_to_broadcast.get_nowait()
    result = asyncio.run(order_sync.sync_once())
    assert result["changed"] is True
    msgs = []
    while not shared.quotes_to_broadcast.empty():
        msgs.append(shared.quotes_to_broadcast.get_nowait())
    snap = next(m for m in msgs if m["type"] == "WorkingOrdersSnapshot")
    assert snap["data"]["orders"] == []


# ─── 10. WebSocket watch：canonical alias 回報 ──────────────

def test_ws_watch_ack_returns_canonical_aliases():
    """tick 廣播用 canonical symbol（如 TSE1101），自選清單存使用者輸入（1101）。
    watch ack 必須回報對應關係，否則前端對不上 key、報價永遠不顯示。"""
    import json as _json
    with client.websocket_connect("/ws/quotes") as ws:
        hello = ws.receive_json()   # 連線後第一個 frame 是 ConnectionState hello
        assert hello["type"] == "ConnectionState"
        ws.send_text(_json.dumps({"action": "watch", "symbols": ["1101", "2330"]}))
        msg = ws.receive_json()
        assert msg["status"] == "success" and msg["action"] == "watch"
        assert set(msg["symbols"]) == {"1101", "2330"}
        # 1101 的 canonical 是 TSE1101 → 要有 alias；2330 相同 → 不用
        assert msg["aliases"] == {"1101": "TSE1101"}
        assert msg["rejected"] == []


# ─── 11. UX quick-wins：背景訂閱 BidAsk / 防誤殺 / TotalVolume / 錯誤封套 ───

def test_subscribe_background_subscribes_tick_and_bidask():
    """背景訂閱必須同時訂 Tick 與 BidAsk（watchlist 切回時 DOM 才有買賣盤）。"""
    sj = shared.shioaji_client
    api = _fake_api()
    api.quote.subscribed.clear()
    old_bg = set(sj._background_symbols)
    try:
        sj._background_symbols.clear()
        canonical = sj.subscribe_background("2890")
        assert canonical == "2890"
        assert ("2890", str(QuoteType.Tick)) in api.quote.subscribed
        assert ("2890", str(QuoteType.BidAsk)) in api.quote.subscribed
        assert "2890" in sj._background_symbols
    finally:
        sj._background_symbols.clear()
        sj._background_symbols.update(old_bg)


def test_main_symbol_switch_spares_background_watched_symbol():
    """主商品切換的 unsubscribe 不可誤殺背景訂閱（watchlist/持倉）的串流；
    非背景商品切走時則必須照常取消訂閱。"""
    sj = shared.shioaji_client
    api = _fake_api()
    api.quote.unsubscribed.clear()
    old_bg = set(sj._background_symbols)
    old_contract = sj.current_contract
    try:
        sj._background_symbols.clear()
        sj.subscribe_background("2890")   # 2890 在 watchlist（背景訂閱）
        sj.subscribe("2890")              # 主商品 = 2890
        sj.subscribe("2330")              # 切走 → 2890 是背景商品，不能取消訂閱
        assert all(code != "2890" for code, _ in api.quote.unsubscribed), \
            "主商品切換誤殺了背景訂閱的 2890"
        sj.subscribe("2890")              # 切走 2330（非背景商品）→ 應照常取消
        assert ("2330", str(QuoteType.Tick)) in api.quote.unsubscribed
        assert ("2330", str(QuoteType.BidAsk)) in api.quote.unsubscribed
    finally:
        sj._background_symbols.clear()
        sj._background_symbols.update(old_bg)
        sj.current_contract = old_contract


# ─── UX 批次 4 Item 10：/api/unwatch 背景退訂（自選移除反訂閱） ───

def test_unwatch_unsubscribes_background_symbol():
    """自選清單移除 → /api/unwatch 必須真的退訂 Tick+BidAsk 並移出 _background_symbols
    （之前完全沒有退訂路徑 → 訂閱洩漏）。"""
    sj = shared.shioaji_client
    api = _fake_api()
    api.quote.unsubscribed.clear()
    old_bg = set(sj._background_symbols)
    old_contract = sj.current_contract
    try:
        sj._background_symbols.clear()
        sj.current_contract = None
        sj.subscribe_background("2890")
        r = client.post("/api/unwatch", json={"symbols": ["2890"]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["removed"] == ["2890"]
        assert body["skipped"] == []
        assert ("2890", str(QuoteType.Tick)) in api.quote.unsubscribed
        assert ("2890", str(QuoteType.BidAsk)) in api.quote.unsubscribed
        assert "2890" not in sj._background_symbols
    finally:
        sj._background_symbols.clear()
        sj._background_symbols.update(old_bg)
        sj.current_contract = old_contract


def test_unwatch_spares_position_symbol():
    """持倉商品即使被自選移除也不能退訂 —— PnL 廣播依賴其 tick 串流。"""
    sj = shared.shioaji_client
    api = _fake_api()
    api.quote.unsubscribed.clear()
    api.positions = [FakePosition("2890", 3, Action.Buy, price=80.0)]
    old_bg = set(sj._background_symbols)
    old_contract = sj.current_contract
    try:
        sj._background_symbols.clear()
        sj.current_contract = None
        sj.subscribe_background("2890")
        r = client.post("/api/unwatch", json={"symbols": ["2890"]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["removed"] == []
        assert body["skipped"] == ["2890"]
        assert all(code != "2890" for code, _ in api.quote.unsubscribed), \
            "持倉商品被 unwatch 退訂，PnL 報價會無聲斷掉"
        assert "2890" in sj._background_symbols
    finally:
        sj._background_symbols.clear()
        sj._background_symbols.update(old_bg)
        sj.current_contract = old_contract


def test_unwatch_spares_current_dom_target_stream():
    """當前 DOM 交易中的 targetSymbol：只移出背景清單、不得取消主訂閱串流
    （之後主商品切走時 subscribe() 會照常取消）。"""
    sj = shared.shioaji_client
    api = _fake_api()
    old_bg = set(sj._background_symbols)
    old_contract = sj.current_contract
    try:
        sj._background_symbols.clear()
        sj.subscribe("2330")              # 主商品 = 2330
        sj.subscribe_background("2330")   # 同時在自選（背景訂閱）
        api.quote.unsubscribed.clear()
        r = client.post("/api/unwatch", json={"symbols": ["2330"]})
        assert r.status_code == 200, r.text
        assert r.json()["removed"] == ["2330"]
        # 串流不能斷（DOM 還在用）
        assert all(code != "2330" for code, _ in api.quote.unsubscribed), \
            "unwatch 誤殺了當前主商品的報價串流"
        # 但已移出背景清單 → 之後切換主商品時會照常退訂
        assert "2330" not in sj._background_symbols
        sj.subscribe("2890")
        assert ("2330", str(QuoteType.Tick)) in api.quote.unsubscribed
    finally:
        sj._background_symbols.clear()
        sj._background_symbols.update(old_bg)
        sj.current_contract = old_contract


def test_unwatch_not_connected_is_noop():
    """未登入時 unwatch 不打 broker，回 skipped。"""
    sj = shared.shioaji_client
    sj._is_connected = False
    r = client.post("/api/unwatch", json={"symbols": ["2890"]})
    assert r.status_code == 200
    assert r.json() == {"status": "success", "removed": [], "skipped": ["2890"]}


def test_tick_total_volume_flows_to_broadcast_queue():
    """v1 tick 帶 total_volume → shioaji_client → bridge → 廣播佇列的
    Tick 訊息必須含 TotalVolume（前端不再自行累加成交量）。"""
    import asyncio
    from types import SimpleNamespace

    async def run():
        old_loop = shared.fastapi_loop
        shared.fastapi_loop = asyncio.get_running_loop()
        try:
            while not shared.quotes_to_broadcast.empty():
                shared.quotes_to_broadcast.get_nowait()
            tick = SimpleNamespace(code="2330", close=505.0, volume=3,
                                   total_volume=12345, open=500.0, high=506.0,
                                   low=499.0, avg_price=502.5, tick_type=1,
                                   datetime="2026-07-05 09:00:00")
            _fake_api().quote.on_tick_stk(None, tick)   # 觸發已註冊的 v1 回呼
            await asyncio.sleep(0.05)                    # 讓 call_soon_threadsafe 消化
            msgs = []
            while not shared.quotes_to_broadcast.empty():
                msgs.append(shared.quotes_to_broadcast.get_nowait())
            return msgs
        finally:
            shared.fastapi_loop = old_loop

    msgs = asyncio.run(run())
    ticks = [m for m in msgs if m["type"] == "Tick" and m["data"]["Symbol"] == "2330"]
    assert ticks, f"沒有 Tick 訊息進佇列: {msgs}"
    assert ticks[0]["data"]["TotalVolume"] == 12345
    assert ticks[0]["data"]["Price"] == 505.0


def test_update_order_not_found_returns_structured_error():
    """改單找不到委託 → detail 必須是結構化封套（code + 中文 user_msg），
    前端 normalizeApiError 才能還原中文訊息。"""
    _fake_api().trades = []   # 沒有任何委託 → not found 路徑
    r = client.post("/api/update_order", json={
        "symbol": "2330", "action": "Buy",
        "old_price": 500.0, "new_price": 501.0,
    })
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert isinstance(detail, dict)
    assert detail["code"] == "ORDER_NOT_FOUND"
    assert "找不到對應的委託" in detail["user_msg"]


# ─── 13. UX batch 2：連線狀態推播 / 熔斷即時廣播 / 盤後 watchdog ───

def test_ws_hello_frame_reports_broker_connection_state():
    """WS 連上後第一個 frame 必須是 ConnectionState hello（晚加入的客戶端
    才能立即同步券商連線狀態，不用等下一次狀態變化）。"""
    with client.websocket_connect("/ws/quotes") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "ConnectionState"
        assert msg["data"]["broker"] == "connected"   # fixture 設 _is_connected=True


def test_risk_breach_emits_risk_status_update_to_broadcast_queue():
    """on_risk_breach 除了 webhook dispatcher 外，必須同時廣播
    RiskStatusUpdate 給前端（熔斷告警即時可見）。"""
    import asyncio

    async def run():
        old_loop = shared.fastapi_loop
        shared.fastapi_loop = asyncio.get_running_loop()
        try:
            while not shared.quotes_to_broadcast.empty():
                shared.quotes_to_broadcast.get_nowait()
            shared.engine.event_bus.on_risk_breach.emit("block", "測試熔斷")
            await asyncio.sleep(0.05)   # 讓 call_soon_threadsafe 消化
            msgs = []
            while not shared.quotes_to_broadcast.empty():
                msgs.append(shared.quotes_to_broadcast.get_nowait())
            return msgs
        finally:
            shared.fastapi_loop = old_loop

    msgs = asyncio.run(run())
    updates = [m for m in msgs if m["type"] == "RiskStatusUpdate"]
    assert updates, f"沒有 RiskStatusUpdate 進佇列: {msgs}"
    assert updates[0]["data"]["level"] == "block"
    assert updates[0]["data"]["reason"] == "測試熔斷"


def test_in_quote_session_handles_cross_midnight_and_security_type():
    """盤後 watchdog 修復核心：_in_quote_session 必須正確處理
    STK/期貨時段表切換與 TAIFEX 夜盤 15:00–05:00 跨午夜區間。"""
    from datetime import datetime as _dt
    from types import SimpleNamespace

    sj = shared.shioaji_client
    old_contract = sj.current_contract
    try:
        # 無合約 → 一律 False（沒有行情可等）
        sj.current_contract = None
        assert sj._in_quote_session() is False

        def at(h, m):
            return _dt(2026, 7, 3, h, m)

        # 期貨（security_type != 'STK'）→ TAIFEX 日盤 + 夜盤
        sj.current_contract = SimpleNamespace(symbol="TXFG6", security_type="FUT")
        assert sj._in_quote_session(now=at(9, 0)) is True      # 日盤中
        assert sj._in_quote_session(now=at(13, 45)) is True    # 日盤收盤邊界
        assert sj._in_quote_session(now=at(14, 30)) is False   # 日夜盤之間
        assert sj._in_quote_session(now=at(23, 59)) is True    # 夜盤（跨午夜前）
        assert sj._in_quote_session(now=at(3, 0)) is True      # 夜盤（跨午夜後）
        assert sj._in_quote_session(now=at(5, 0)) is True      # 夜盤收盤邊界
        assert sj._in_quote_session(now=at(6, 0)) is False     # 夜盤結束後

        # 股票（'STK'）→ 只有 TSE 日盤，夜間一律 False（盤後不得觸發 watchdog）
        sj.current_contract = SimpleNamespace(symbol="2330", security_type="STK")
        assert sj._in_quote_session(now=at(10, 0)) is True
        assert sj._in_quote_session(now=at(8, 50)) is False    # 開盤前
        assert sj._in_quote_session(now=at(14, 0)) is False    # 收盤後
        assert sj._in_quote_session(now=at(23, 0)) is False    # 深夜
        assert sj._in_quote_session(now=at(3, 0)) is False     # 凌晨
    finally:
        sj.current_contract = old_contract


# ─── 14. Sprint C：CHASE 追價智慧單 ─────────────────────────

def _emit_bidask(symbol, bid, ask):
    """餵一筆五檔（最佳一檔）給引擎 —— 走 EventBus，與 bridge 的發射點同格式。"""
    shared.engine.event_bus.on_bidask.emit(symbol, {
        "Symbol": symbol, "BidPrice": [bid], "AskPrice": [ask],
        "BidVolume": [10], "AskVolume": [10],
    })


def test_create_chase_via_rest_with_defaults():
    """CHASE 契約欄位 + 預設值：quantity 別名、立即以限價掛在最佳對手價。"""
    _emit_bidask("2330", 500.0, 501.0)
    r = client.post("/api/smart_orders", json={
        "order_type": "CHASE", "symbol": "2330", "action": "Buy", "quantity": 2,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "success" and body["id"]
    assert body["chase_price"] == 501.0
    # 進場單走 order_guard 統一路徑 → 真的送到券商（Buy → 掛賣一 501）
    assert len(_fake_api().placed_orders) == 1
    sent = _fake_api().placed_orders[0]
    assert sent["code"] == "2330" and sent["qty"] == 2 and sent["price"] == 501.0
    # 預設值與狀態欄位（前端顯示「追價中 n/max」所需）
    active = client.get("/api/smart_orders").json()
    chase = next(o for o in active if o["order_type"] == "CHASE")
    assert chase["max_chase_ticks"] == 10
    assert chase["reprice_ticks"] == 1
    assert chase["reprice_interval_ms"] == 1500
    assert chase["final_action"] == "GIVE_UP"
    assert chase["chase_status"] == "CHASING"
    assert chase["chase_price"] == 501.0
    assert chase["reprice_count"] == 0
    assert chase["remaining_qty"] == 2


def test_create_chase_invalid_values_structured_error():
    """非法值 → 結構化 {code, user_msg} 錯誤（比照現有 router 慣例）。"""
    base = {"order_type": "CHASE", "symbol": "2330", "action": "Buy", "quantity": 1}

    r1 = client.post("/api/smart_orders", json={**base, "reprice_interval_ms": 100})
    assert r1.status_code == 422
    d1 = r1.json()["detail"]
    assert d1["code"] == "INVALID_CHASE" and "500" in d1["user_msg"]

    r2 = client.post("/api/smart_orders", json={**base, "final_action": "HOLD"})
    assert r2.status_code == 422
    assert r2.json()["detail"]["code"] == "INVALID_CHASE"

    r3 = client.post("/api/smart_orders", json={**base, "max_chase_ticks": 0})
    assert r3.status_code == 422
    assert r3.json()["detail"]["code"] == "INVALID_CHASE"

    r4 = client.post("/api/smart_orders", json={**base, "reprice_ticks": 0})
    assert r4.status_code == 422
    assert r4.json()["detail"]["code"] == "INVALID_CHASE"

    r5 = client.post("/api/smart_orders", json={
        "order_type": "CHASE", "symbol": "2330", "action": "Buy",  # 缺 quantity/qty
    })
    assert r5.status_code == 422
    assert r5.json()["detail"]["code"] == "INVALID_QTY"

    assert not _fake_api().placed_orders  # 驗證失敗不得送單


def test_create_chase_without_quote_rejected():
    """取不到五檔也沒有最新成交價 → 結構化 NO_QUOTE，不建單。"""
    eng = shared.engine.smart_order_engine
    eng._best_quotes.pop("6488", None)
    eng._last_prices.pop("6488", None)
    r = client.post("/api/smart_orders", json={
        "order_type": "CHASE", "symbol": "6488", "action": "Buy", "quantity": 1,
    })
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "NO_QUOTE"
    assert not _fake_api().placed_orders
    assert client.get("/api/smart_orders").json() == []


def test_chase_reprices_via_quote_flow():
    """賣一不利移動 ≥ 1 tick → order executor 上 cancel-replace 到新對手價。"""
    _emit_bidask("2330", 500.0, 501.0)
    r = client.post("/api/smart_orders", json={
        "order_type": "CHASE", "symbol": "2330", "action": "Buy", "quantity": 1,
    })
    assert r.status_code == 200, r.text
    # 賣一 501 → 502（tick=1.0）：觸發改價（第一次改價不受 interval 限制）
    _emit_bidask("2330", 501.0, 502.0)
    assert _wait_for(lambda: len(_fake_api().placed_orders) == 2), "改價單未送出"
    assert _fake_api().placed_orders[1]["price"] == 502.0
    assert _wait_for(lambda: _fake_api().cancelled_orders), "舊掛單未撤"
    chase = next(o for o in client.get("/api/smart_orders").json()
                 if o["order_type"] == "CHASE")
    assert chase["reprice_count"] == 1
    assert chase["chase_price"] == 502.0


def test_cancel_chase_via_rest_cancels_working_order():
    """DELETE 智慧單端點對 CHASE 生效 = 撤掛單 + 標 CANCELLED。"""
    _emit_bidask("2330", 500.0, 501.0)
    r = client.post("/api/smart_orders", json={
        "order_type": "CHASE", "symbol": "2330", "action": "Sell", "quantity": 1,
    })
    assert r.status_code == 200, r.text
    oid = r.json()["id"]
    r2 = client.delete(f"/api/smart_orders/{oid}")
    assert r2.status_code == 200
    assert client.get("/api/smart_orders").json() == []
    # 掛單真的被撤（order executor 上非同步執行）
    assert _wait_for(lambda: _fake_api().cancelled_orders), "working order 未被撤"
    eng = shared.engine.smart_order_engine
    d = next(o for o in eng.get_all_orders() if o["id"] == oid)
    assert d["chase_status"] == "CANCELLED"


def test_chase_filled_via_deal_callback():
    """券商 Deal callback → on_fill → CHASE 全成標 FILLED。"""
    _emit_bidask("2330", 500.0, 501.0)
    r = client.post("/api/smart_orders", json={
        "order_type": "CHASE", "symbol": "2330", "action": "Buy", "quantity": 1,
    })
    assert r.status_code == 200, r.text
    oid = r.json()["id"]
    ordno = _fake_api().trades[-1].order.ordno  # 進場單的 ordno
    cb = _fake_api()._order_callback
    cb("OrderState.StockDeal", {"code": "2330", "action": "Buy", "price": 501.0,
                                "quantity": 1, "ordno": ordno, "exchange_seq": "CH1"})
    eng = shared.engine.smart_order_engine
    assert _wait_for(lambda: not eng.get_active_orders("2330")), "全成後未離開活躍清單"
    d = next(o for o in eng.get_all_orders() if o["id"] == oid)
    assert d["chase_status"] == "FILLED"
    assert d["filled_qty"] == 1 and d["remaining_qty"] == 0


def test_chase_external_cancel_detected_by_order_sync():
    """外部管道把掛單撤了 → 對帳迴圈偵測 → CANCELLED_EXTERNAL 終態。"""
    import asyncio
    from backend.services import order_sync

    _emit_bidask("2330", 500.0, 501.0)
    r = client.post("/api/smart_orders", json={
        "order_type": "CHASE", "symbol": "2330", "action": "Buy", "quantity": 1,
    })
    assert r.status_code == 200, r.text
    oid = r.json()["id"]
    eng = shared.engine.smart_order_engine
    old_grace = eng._external_cancel_grace_ms
    try:
        eng._external_cancel_grace_ms = 0.0
        # 模擬外部撤單：list_trades 回報該委託 Cancelled
        _fake_api().cancel_order(_fake_api().trades[-1])
        order_sync._last_fingerprint = ""
        asyncio.run(order_sync.sync_once())
        d = next(o for o in eng.get_all_orders() if o["id"] == oid)
        assert d["chase_status"] == "CANCELLED_EXTERNAL"
        assert d["is_active"] is False
        assert client.get("/api/smart_orders").json() == []  # 不留殭屍
    finally:
        eng._external_cancel_grace_ms = old_grace


def test_confirm_order_cancelled_reports_inflight_fill():
    """P0-1 生產路徑：撤單非同步 + 撤單在途舊單部分成交 →
    ShioajiClient.confirm_order_cancelled 回報實際累計成交量，
    CHASE 才能以真正剩量掛新腿、不超額。"""
    api = _fake_api()
    sj = shared.shioaji_client
    api.async_cancel = True
    try:
        trade = sj.place_order("2330", 500.0, Action.Buy, 3)
        ordno = trade.order.ordno
        # 撤單送出當下，舊單在交易所端成交 2 口（撤單在途競速）
        api.cancel_race_hook = lambda t: api.fill_trade(t, 2, 500.0, "d1")
        assert sj.cancel_order_by_ids([ordno]) is True     # 引擎精準撤單路徑
        api.flush_cancels()                                # 撤單非同步生效（剩 1 口 → Cancelled）
        info = sj.confirm_order_cancelled([ordno])
        assert info is not None
        assert info["cancelled"] is True
        assert info["filled_qty"] == 2                     # 實際已成 2 → 剩量應為 1
    finally:
        api.async_cancel = False
        api.cancel_race_hook = None
        api._pending_cancels.clear()


def test_confirm_order_cancelled_timeout_when_still_active():
    """撤單未生效（仍活躍）→ confirm 回 cancelled=False，CHASE 本輪放棄不送新單。"""
    api = _fake_api()
    sj = shared.shioaji_client
    trade = sj.place_order("2330", 500.0, Action.Buy, 2)
    ordno = trade.order.ordno
    # 委託仍在活躍狀態、未撤 → 逾時未確認
    info = sj.confirm_order_cancelled([ordno], timeout_s=0.05, poll_interval_s=0.01)
    assert info is not None and info["cancelled"] is False


def test_cancel_orders_by_action_price_still_sync():
    """協調保障：前端 /cancel_all price 分支用的 cancel_orders_by_action_price
    在 fake 上仍為同步生效（撤單即標 Cancelled）。"""
    api = _fake_api()
    sj = shared.shioaji_client
    t = sj.place_order("2330", 500.0, Action.Buy, 1)
    n = sj.cancel_orders_by_action_price("2330", Action.Buy, 500.0)
    assert n == 1
    assert t.status.status.name == "Cancelled"


def test_watchdog_session_union_over_background_subscriptions():
    """#11：只有背景訂閱、current_contract=None 時，watchdog 也要能依背景商品
    時段判斷（時段聯集），而非因為沒有主商品就永遠不觸發。"""
    from datetime import datetime as _dt
    sj = shared.shioaji_client
    old_cur, old_bg = sj.current_contract, set(sj._background_symbols)
    try:
        sj.current_contract = None
        sj._background_symbols = set()
        # 完全沒有訂閱 → 不觸發（沒有行情可等）
        assert sj._any_subscribed_in_session(now=_dt(2026, 7, 3, 10, 0)) is False
        # 只有背景訂閱一檔股票（無主商品）→ 日盤中仍算「該有行情」
        sj._background_symbols = {"2330"}
        assert sj._any_subscribed_in_session(now=_dt(2026, 7, 3, 10, 0)) is True
        assert sj._any_subscribed_in_session(now=_dt(2026, 7, 3, 3, 0)) is False
    finally:
        sj.current_contract, sj._background_symbols = old_cur, old_bg


def test_list_positions_strict_distinguishes_failure_from_empty(monkeypatch):
    """#12：真無倉 → []；所有帳號查詢失敗 → strict 版 raise（寬鬆版仍回 []）。"""
    api = _fake_api()
    sj = shared.shioaji_client
    api.positions = []
    assert sj.list_positions_strict() == []          # 真無倉
    def _boom(acc=None):
        raise RuntimeError("broker down")
    monkeypatch.setattr(api, "list_positions", _boom)
    with pytest.raises(Exception):
        sj.list_positions_strict()                   # 查詢失敗 → 可辨識
    assert sj.list_positions() == []                 # 寬鬆版仍 best-effort


# ─── 12. API Token 認證（最後執行：會 reload main） ──────────

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
            hello = ws.receive_json()   # 第一個 frame 是 ConnectionState hello
            assert hello["type"] == "ConnectionState"
            ws.send_text('{"action":"subscribe","symbol":"2330"}')
            msg = ws.receive_json()
            assert msg["status"] in ("success", "error")  # 未登入回 error，但代表已通過認證
    finally:
        os.environ.pop("LIGHTRADE_API_TOKEN", None)
