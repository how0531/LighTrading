"""
shared.py — 後端共用狀態與工具

所有 routers / services 從此處 import 共用的單例與工具函式，
避免循環引用和全域變數散落在 main.py 中。
"""
import asyncio
import logging
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

# 全域訂單序號，用於解決前端收單的競態問題
_order_seq = int(time.time() * 1000)

def generate_order_seq() -> int:
    global _order_seq
    _order_seq += 1
    return _order_seq


# ─── 工具函式 ──────────────────────────────────────────────

def format_datetime(dt) -> str:
    """將 datetime 物件轉換為 ISO 字串"""
    if hasattr(dt, 'isoformat'):
        return dt.isoformat()
    return str(dt)


async def run_in_qt_thread(func, *args, **kwargs):
    """
    將函數丟到 Qt 執行緒環境執行。
    目前 uvicorn 預設單 worker 模式下可直接同步呼叫。
    """
    return func(*args, **kwargs)


async def broadcast_ws(msg_dict: dict):
    """將訊息廣播給所有活躍的 WebSocket 連接"""
    import json
    message = json.dumps(msg_dict)
    for conn in list(active_connections):
        try:
            await conn.send_text(message)
        except Exception:
            active_connections.discard(conn)
