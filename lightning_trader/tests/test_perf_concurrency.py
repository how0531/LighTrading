"""
test_perf_concurrency.py — WS5 效能/並發收尾

自帶 fake 安裝與狀態重置，不依賴 conftest 的任何 fixture。

涵蓋：
  D3（廣播佇列背壓）：shared.BroadcastQueue
    - 報價佇列有界 + drop-oldest：滿了不成長、丟最舊
    - 關鍵回報不丟且優先於報價（get / get_nowait）
    - 大量報價灌爆時，關鍵回報照樣一筆不少
  D2（PnL head-of-line）：pnl_broadcaster._broadcast_cycle
    - 慢 list_positions 不阻塞風控餵入（注入慢函式模擬）
    - 持倉刷新走背景 task（非阻塞），完成後更新快取
"""
import os
import sys
import time
import asyncio
from types import SimpleNamespace

import pytest

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from backend.shared import BroadcastQueue


# ─────────────────────────── D3：廣播佇列背壓 ───────────────────────────

def _quote(sym, i):
    return {"type": "Tick", "data": {"Symbol": sym, "Price": i}}

def _bidask(sym):
    return {"type": "BidAsk", "data": {"Symbol": sym}}

def _critical(seq):
    return {"type": "OrderUpdate", "data": {"seq": seq}}


def test_quote_queue_is_bounded_and_drops_oldest():
    q = BroadcastQueue(quote_maxsize=10)
    for i in range(25):
        q.put_nowait(_quote("TXFR1", i))
    # 長度封頂在 maxsize，不隨灌入成長
    assert q.quote_qsize() == 10
    # 丟掉的是最舊的 15 筆
    assert q.dropped_quotes == 15
    # 保留下來的是最新 10 筆（15..24），且順序保持
    got = [q.get_nowait()["data"]["Price"] for _ in range(10)]
    assert got == list(range(15, 25))
    assert q.empty()


def test_critical_reports_are_never_dropped():
    q = BroadcastQueue(quote_maxsize=5)
    for s in range(50):
        q.put_nowait(_critical(s))
    # 關鍵佇列無界：50 筆全在
    assert q.critical_qsize() == 50
    assert q.dropped_quotes == 0
    seqs = []
    while not q.critical_empty():
        seqs.append(q.pop_critical_nowait()["data"]["seq"])
    assert seqs == list(range(50))


def test_critical_has_priority_over_quotes_on_get_nowait():
    q = BroadcastQueue(quote_maxsize=100)
    # 交錯放入報價與關鍵回報
    q.put_nowait(_quote("A", 1))
    q.put_nowait(_critical(1))
    q.put_nowait(_quote("A", 2))
    q.put_nowait(_bidask("A"))
    q.put_nowait(_critical(2))

    drained = []
    while not q.empty():
        drained.append(q.get_nowait())
    types = [m["type"] for m in drained]
    # 兩筆關鍵回報必須排在所有報價前面
    assert types[:2] == ["OrderUpdate", "OrderUpdate"]
    assert set(types[2:]) == {"Tick", "BidAsk"}
    # 關鍵回報一筆不少且順序保持
    assert [m["data"]["seq"] for m in drained if m["type"] == "OrderUpdate"] == [1, 2]


def test_critical_priority_under_quote_flood():
    """慢客戶端情境：報價灌爆有界佇列，關鍵回報仍不丟、仍優先。"""
    q = BroadcastQueue(quote_maxsize=8)
    for i in range(1000):
        q.put_nowait(_quote("A", i))
        if i % 100 == 0:
            q.put_nowait(_critical(i))
    # 報價封頂、關鍵全保
    assert q.quote_qsize() == 8
    criticals = []
    while not q.critical_empty():
        criticals.append(q.pop_critical_nowait()["data"]["seq"])
    assert criticals == [0, 100, 200, 300, 400, 500, 600, 700, 800, 900]


def test_async_get_returns_critical_first():
    async def _run():
        q = BroadcastQueue(quote_maxsize=10)
        q.put_nowait(_quote("A", 1))
        q.put_nowait(_critical(7))
        first = await q.get()
        second = await q.get()
        return first, second
    first, second = asyncio.run(_run())
    assert first["type"] == "OrderUpdate"
    assert second["type"] == "Tick"


def test_async_get_blocks_until_put():
    async def _run():
        q = BroadcastQueue()
        async def producer():
            await asyncio.sleep(0.02)
            q.put_nowait(_critical(99))
        asyncio.ensure_future(producer())
        item = await asyncio.wait_for(q.get(), timeout=1.0)
        return item
    item = asyncio.run(_run())
    assert item["data"]["seq"] == 99


def test_backward_compatible_empty_and_get_nowait():
    """order_sync / test_api_integration 仍用 empty() + get_nowait() 排空。"""
    q = BroadcastQueue()
    assert q.empty()
    q.put_nowait({"type": "TradeUpdate", "data": {"source": "order_sync"}})
    q.put_nowait({"type": "WorkingOrdersSnapshot", "data": {"orders": []}})
    msgs = []
    while not q.empty():
        msgs.append(q.get_nowait())
    assert {m["type"] for m in msgs} == {"TradeUpdate", "WorkingOrdersSnapshot"}
    with pytest.raises(asyncio.QueueEmpty):
        q.get_nowait()


# ─────────────────────────── D2：PnL head-of-line ───────────────────────────

class _RecordingRiskManager:
    def __init__(self):
        self.pnl_calls = []
        self.pos_calls = []
    def update_positions(self, positions):
        self.pos_calls.append(list(positions))
    def update_daily_pnl(self, realized=None, unrealized=None):
        self.pnl_calls.append({"realized": realized, "unrealized": unrealized})


class _SlowClient:
    """list_positions 故意很慢（模擬排在 kbars/搜尋後面的 head-of-line）。"""
    def __init__(self, new_positions, delay=1.0):
        self._is_connected = True
        self._latest_prices = {"TXFR1": 17050.0}
        self._new_positions = new_positions
        self._delay = delay
        self.list_positions_started = False
    def list_positions(self, acc=None):
        self.list_positions_started = True
        time.sleep(self._delay)  # 慢查詢（在 sync_executor thread 上）
        return self._new_positions


@pytest.fixture()
def pnl_env():
    """安裝/還原 pnl_broadcaster 依賴的 shared 狀態與模組全域。"""
    from backend import shared
    from backend.services import pnl_broadcaster as pb

    saved = dict(
        client=shared.shioaji_client,
        engine=shared.engine,
        loop=shared.fastapi_loop,
        pos_cache=pb._pos_cache,
        pos_cache_time=pb._pos_cache_time,
        inflight=pb._refresh_inflight,
    )
    try:
        yield shared, pb
    finally:
        shared.shioaji_client = saved["client"]
        shared.engine = saved["engine"]
        shared.fastapi_loop = saved["loop"]
        pb._pos_cache = saved["pos_cache"]
        pb._pos_cache_time = saved["pos_cache_time"]
        pb._refresh_inflight = saved["inflight"]
        pb._invalidate_event.clear()


def test_slow_list_positions_does_not_block_risk_feed(pnl_env):
    """核心 D2 不變式：即使 list_positions 睡 1s，_broadcast_cycle 立即返回、
    風控在慢查詢完成前就已被餵入最新未實現損益。"""
    shared, pb = pnl_env

    new_positions = [{"symbol": "TXFR1", "qty": 3, "direction": "Buy", "price": 17000.0, "pnl": 0}]
    client = _SlowClient(new_positions, delay=1.0)
    rm = _RecordingRiskManager()

    shared.shioaji_client = client
    shared.engine = SimpleNamespace(risk_manager=rm)

    # 目前快取有 1 口多單；latest price 17050 → 未實現 (50)*1*200 = 10000
    pb._pos_cache = [{"symbol": "TXFR1", "qty": 1, "direction": "Buy", "price": 17000.0, "pnl": 0}]
    pb._pos_cache_time = 0.0            # 逾時 → 觸發刷新
    pb._refresh_inflight = False
    pb._invalidate_event.clear()

    async def _run():
        t0 = time.monotonic()
        await pb._broadcast_cycle()
        elapsed = time.monotonic() - t0
        # 慢查詢在背景 task，cycle 本身不 await 它 → 立即返回（遠小於 1s delay）
        assert elapsed < 0.4, f"_broadcast_cycle 被慢 list_positions 阻塞了：{elapsed:.3f}s"
        # 風控已被餵入（不等 list_positions）
        assert rm.pnl_calls, "風控未被餵入未實現損益"
        assert rm.pnl_calls[-1]["unrealized"] == 10000
        # 背景刷新確實已啟動
        assert pb._refresh_task is not None
        # 讓背景刷新完成，驗證快取被非阻塞更新為新持倉
        await asyncio.wait_for(pb._refresh_task, timeout=3.0)
        assert client.list_positions_started
        assert pb._pos_cache == new_positions

    asyncio.run(_run())


def test_refresh_uses_sync_executor_not_broker(pnl_env, monkeypatch):
    """D2：持倉刷新必須走 sync_executor（run_in_sync_thread），與 broker 佇列隔離。"""
    shared, pb = pnl_env

    calls = {"sync": 0, "broker": 0}

    async def fake_sync(func, *a, **k):
        calls["sync"] += 1
        return func(*a, **k)

    async def fake_broker(func, *a, **k):
        calls["broker"] += 1
        return func(*a, **k)

    monkeypatch.setattr(shared, "run_in_sync_thread", fake_sync)
    monkeypatch.setattr(shared, "run_in_broker_thread", fake_broker)

    new_positions = [{"symbol": "TXFR1", "qty": 2, "direction": "Buy", "price": 17000.0, "pnl": 0}]
    shared.shioaji_client = _SlowClient(new_positions, delay=0.0)
    shared.engine = SimpleNamespace(risk_manager=_RecordingRiskManager())

    pb._pos_cache = []
    pb._pos_cache_time = 0.0
    pb._refresh_inflight = False
    pb._invalidate_event.clear()

    async def _run():
        task = pb._schedule_position_refresh()
        assert task is not None
        await asyncio.wait_for(task, timeout=3.0)

    asyncio.run(_run())
    assert calls["sync"] == 1
    assert calls["broker"] == 0
    assert pb._pos_cache == new_positions
