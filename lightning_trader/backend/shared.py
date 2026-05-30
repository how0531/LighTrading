"""
shared.py — 後端共用狀態與工具

所有 routers / services 從此處 import 共用的單例與工具函式，
避免循環引用和全域變數散落在 main.py 中。
"""
import asyncio
import itertools
import logging
import threading
from datetime import datetime
import time
from fastapi import WebSocket

logger = logging.getLogger(__name__)

# ─── 共用單例 ───────────────────────────────────────────────
# 這些在 main.py 的模組頂層初始化，其他模組透過 import shared 取用

# TradingEngine 實例（由 main.py 初始化後設定）
engine = None
shioaji_client = None

# FastAPI asyncio event loop 參考（由 lifespan 設定）
fastapi_loop: asyncio.AbstractEventLoop = None

# 活躍的 WebSocket 連接
active_connections: set[WebSocket] = set()

# Shioaji → WebSocket 的報價佇列
quotes_to_broadcast: asyncio.Queue = asyncio.Queue()

# ─── 訂單序號（分流） ──────────────────────────────────────
# 分成兩條獨立流：
#   - callback_seq：Shioaji order_callback 推送的 OrderUpdate（broker thread）
#   - snapshot_seq：REST API 主動回傳的快照（FastAPI thread）
# 兩條序號流互不干擾，前端各自比較自己的 ref，避免交錯導致的丟更新。
# 用 itertools.count + next() 取得 thread-safe（CPython 內建保證原子性）。
_base = int(time.time() * 1000)
_callback_counter = itertools.count(_base + 1)
_snapshot_counter = itertools.count(_base + 1)

def generate_callback_seq() -> int:
    return next(_callback_counter)

def generate_snapshot_seq() -> int:
    return next(_snapshot_counter)

# 向後相容：保留舊名，預設指到 snapshot_seq
def generate_order_seq() -> int:
    return generate_snapshot_seq()


# ─── 工具函式 ──────────────────────────────────────────────

def format_datetime(dt) -> str:
    """將 datetime 物件轉換為 ISO 字串"""
    if hasattr(dt, 'isoformat'):
        return dt.isoformat()
    return str(dt)


async def run_in_qt_thread(func, *args, **kwargs):
    """
    將同步的 Shioaji API 呼叫丟到 default executor 執行，
    避免阻塞 FastAPI/uvicorn 的 asyncio event loop。

    歷史名稱保留為 *_qt_thread* 以維持呼叫端相容性（早期版本走 QThread）。
    現在實際上是 `asyncio.to_thread`：用 ThreadPoolExecutor 跑 Shioaji 的同步 API，
    讓 quote_broadcaster / pnl_broadcaster 等其他 task 在同時段不會被卡住。
    """
    return await asyncio.to_thread(func, *args, **kwargs)


async def broadcast_ws(msg_dict: dict):
    """將訊息廣播給所有活躍的 WebSocket 連接"""
    import json
    message = json.dumps(msg_dict)
    for conn in list(active_connections):
        try:
            await conn.send_text(message)
        except Exception:
            active_connections.discard(conn)
