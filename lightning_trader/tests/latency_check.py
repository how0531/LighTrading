"""
latency_check.py — 端到端延遲量測（手動執行，不在 pytest 範圍內）

跑法（backend 與 frontend 應已啟動）：
    python3 tests/latency_check.py --symbol TXFR1 --secs 30

量測項目：
  - Tick → WebSocket 收到 PnLUpdate 的端到端延遲（後端推播延遲）
  - /api/sync_all 往返延遲（http path）

依賴：websockets, httpx
若未安裝會印出指示再退出。
"""
import argparse
import asyncio
import json
import statistics
import time
from typing import List

try:
    import websockets
    import httpx
except ImportError:
    print("請先安裝：pip install websockets httpx")
    raise SystemExit(1)


async def _latency_pnl_stream(host: str, symbol: str, secs: int) -> List[float]:
    """訂閱 ws，收到 PnLUpdate 就量「自上一筆以來的間隔」並抽樣"""
    samples: list[float] = []
    url = f"ws://{host}/ws/quotes"
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"action": "subscribe", "symbol": symbol}))
        deadline = time.monotonic() + secs
        last = None
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            except asyncio.TimeoutError:
                continue
            data = json.loads(raw)
            if data.get("type") == "PnLUpdate":
                now = time.monotonic()
                if last is not None:
                    samples.append((now - last) * 1000)
                last = now
    return samples


async def _latency_sync_all(host: str, n: int = 20) -> List[float]:
    samples: list[float] = []
    async with httpx.AsyncClient(base_url=f"http://{host}", timeout=10.0) as c:
        for _ in range(n):
            t0 = time.monotonic()
            try:
                r = await c.post("/api/sync_all")
                if r.status_code == 200:
                    samples.append((time.monotonic() - t0) * 1000)
            except Exception as e:
                print(f"sync_all 失敗：{e}")
    return samples


def _stats(name: str, samples: List[float]):
    if not samples:
        print(f"{name}: 無樣本")
        return
    s = sorted(samples)
    p50 = s[len(s) // 2]
    p95 = s[int(len(s) * 0.95)] if len(s) > 1 else s[-1]
    print(
        f"{name:>20}  n={len(s):3d}  "
        f"mean={statistics.mean(s):.0f}ms  p50={p50:.0f}ms  "
        f"p95={p95:.0f}ms  max={max(s):.0f}ms"
    )


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1:8000")
    ap.add_argument("--symbol", default="TXFR1")
    ap.add_argument("--secs", type=int, default=30)
    args = ap.parse_args()

    print(f"量測 host={args.host} symbol={args.symbol} secs={args.secs}\n")
    pnl_task = asyncio.create_task(_latency_pnl_stream(args.host, args.symbol, args.secs))
    sync_samples = await _latency_sync_all(args.host, n=10)
    pnl_samples = await pnl_task

    print()
    _stats("PnLUpdate 推播間隔", pnl_samples)
    _stats("/api/sync_all RTT", sync_samples)


if __name__ == "__main__":
    asyncio.run(main())
