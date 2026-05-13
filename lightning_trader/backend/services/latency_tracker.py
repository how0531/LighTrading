"""
latency_tracker.py — 量測「下單 → 第一筆成交回報」端到端延遲

時序：
  POST /api/place_order
    ↓ shioaji place_order 回傳 trade（含 id / seqno）
    ↓ latency_tracker.on_place(order_id) 記下「我們送出的當下」
  ...
  bridge.on_shioaji_order_update 收到 state=Deal/Fill
    ↓ latency_tracker.on_fill(order_id) 計算 now - place_time
    ↓ append 到 ring buffer

聚合：
  get_metrics() → {count, p50_ms, p95_ms, max_ms}
"""
from __future__ import annotations
import threading
import time
from collections import deque
from typing import Optional

# 同時記住「最近 200 筆下單時戳」與「最近 200 筆觀測到的延遲」
_LOCK = threading.Lock()
_PLACED: dict[str, float] = {}                  # order_id → time.monotonic when placed
_PLACE_ORDER_MAX = 500                           # 超過就 evict 最舊
_LATENCIES_MS: deque[float] = deque(maxlen=200)  # ring buffer


def on_place(order_id: Optional[str]) -> None:
    """Backend /place_order 取得 trade.id 後立即呼叫。"""
    if not order_id:
        return
    now = time.monotonic()
    with _LOCK:
        # 超過上限就丟最舊那筆（FIFO 順序由插入決定，但 dict 沒有強保證；用近似 LRU）
        if len(_PLACED) >= _PLACE_ORDER_MAX:
            try:
                oldest = next(iter(_PLACED))
                _PLACED.pop(oldest, None)
            except StopIteration:
                pass
        _PLACED[str(order_id)] = now


def on_fill(order_id: Optional[str]) -> Optional[float]:
    """Bridge 收到 Filled/Deal callback 時呼叫；回傳量測到的 ms（沒配到就 None）。"""
    if not order_id:
        return None
    key = str(order_id)
    with _LOCK:
        placed_at = _PLACED.pop(key, None)
        if placed_at is None:
            return None
        elapsed_ms = (time.monotonic() - placed_at) * 1000.0
        _LATENCIES_MS.append(elapsed_ms)
        return elapsed_ms


def get_metrics() -> dict:
    """供 /api/metrics 取用：count, p50_ms, p95_ms, max_ms。空樣本回 None。"""
    with _LOCK:
        samples = list(_LATENCIES_MS)
    if not samples:
        return {"count": 0, "p50_ms": None, "p95_ms": None, "max_ms": None}
    samples.sort()
    n = len(samples)
    p50 = samples[n // 2]
    # P95 取上界（小樣本時偏向悲觀）
    p95_idx = max(0, min(n - 1, int(n * 0.95)))
    p95 = samples[p95_idx]
    return {
        "count": n,
        "p50_ms": round(p50, 1),
        "p95_ms": round(p95, 1),
        "max_ms": round(max(samples), 1),
    }


def reset() -> None:
    """測試用：清狀態。Production 不該呼叫。"""
    with _LOCK:
        _PLACED.clear()
        _LATENCIES_MS.clear()
