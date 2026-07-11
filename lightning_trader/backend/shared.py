"""
shared.py — 後端共用狀態與工具

所有 routers / services 從此處 import 共用的單例與工具函式，
避免循環引用和全域變數散落在 main.py 中。
"""
import asyncio
import functools
import logging
import time
from concurrent.futures import ThreadPoolExecutor
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
#   - callback_seq：Shioaji order_callback 推送的 OrderUpdate
#   - snapshot_seq：REST API 主動回傳的快照（place_order / cancel_all / order_history）
# 兩條序號流互不干擾，前端各自比較自己的 ref，避免交錯導致的丟更新。
_base = int(time.time() * 1000)
_callback_seq = _base
_snapshot_seq = _base

def generate_callback_seq() -> int:
    global _callback_seq
    _callback_seq += 1
    return _callback_seq

def generate_snapshot_seq() -> int:
    global _snapshot_seq
    _snapshot_seq += 1
    return _snapshot_seq

# 向後相容：保留舊名，預設指到 snapshot_seq
def generate_order_seq() -> int:
    return generate_snapshot_seq()


# ─── 工具函式 ──────────────────────────────────────────────

def format_datetime(dt) -> str:
    """將 datetime 物件轉換為 ISO 字串"""
    if hasattr(dt, 'isoformat'):
        return dt.isoformat()
    return str(dt)


# ─── 券商呼叫執行緒 ─────────────────────────────────────────
# Shioaji 的呼叫（login / place_order / list_positions / search ...）都是
# 阻塞式網路 I/O。舊版的 run_in_qt_thread 名字上是「丟到別的執行緒」，
# 實際上卻是同步直呼 —— 所有券商呼叫都卡在 asyncio event loop 上，
# 期間 WebSocket 報價推送全部停擺。
#
# 改成真正的單 worker executor：
#   - 不阻塞 event loop（報價 / PnL 廣播不受券商 RTT 影響）
#   - max_workers=1 序列化所有券商呼叫，保留原本的順序語意，
#     也避免對 Shioaji SDK 做並發呼叫的執行緒安全疑慮
broker_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="broker")


async def run_in_broker_thread(func, *args, **kwargs):
    """在 broker executor 上執行阻塞式券商呼叫，不卡 event loop。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(broker_executor, functools.partial(func, *args, **kwargs))


def submit_to_broker_thread(fn):
    """給非 async 情境把一般券商工作丟進 broker executor。"""
    return broker_executor.submit(fn)


# 專用下單通道：智慧單觸發的保護性出場不能排在 kbars 下載 /
# 全商品搜尋等慢查詢後面。獨立單 worker，只跑下單類的快操作。
order_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="order")


def submit_order_task(fn):
    """智慧單觸發下單專用通道（低延遲，不與慢查詢共用佇列）。"""
    return order_executor.submit(fn)


# 背景對帳/重算通道：order_sync 的 update_status+list_trades（每 2.5s）
# 與已實現損益的 FIFO 重算都是慢工作，不能排在「手動下單」共用的
# broker 佇列前面造成 head-of-line 阻塞。
sync_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sync")


async def run_in_sync_thread(func, *args, **kwargs):
    """在背景對帳 executor 上執行慢的券商查詢/重算，不佔用下單佇列。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(sync_executor, functools.partial(func, *args, **kwargs))


def submit_sync_task(fn):
    return sync_executor.submit(fn)


# CHASE 追價的「可阻塞輪詢」通道（D1）：cancel-replace / 收尾轉市價會做
# confirm_order_cancelled 這種 ~1s 的撤單終態輪詢。若與保護性停損共用
# order_executor（單 worker），一筆追價輪詢會 head-of-line 阻塞停損出場的
# 市價單。獨立一條阻塞用 executor，讓 order_executor 只跑「不阻塞的快下單」
# （智慧單觸發的保護性市價單），追價的阻塞輪詢走這裡、彼此不排隊。
blocking_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="blocking")


def submit_blocking_task(fn):
    """CHASE cancel-replace / 收尾的可阻塞輪詢專用通道（不與保護性停損下單共用佇列）。"""
    return blocking_executor.submit(fn)


async def drop_connection(conn: WebSocket) -> None:
    """
    把 WebSocket 從活躍集合移除「並且真正關閉它」。

    之前各廣播器逾時/失敗時只做 discard 不 close —— 客戶端的 socket
    仍是 OPEN，onclose 永遠不會觸發、也就永遠不會自動重連，
    報價從此凍結（使用者看到的「報價常常不顯示」主因之一）。
    close 之後客戶端會收到 onclose → 走既有的指數退避重連。
    """
    active_connections.discard(conn)
    try:
        await conn.close(code=1011)  # internal error / going away
    except Exception:
        pass  # 已斷線的 socket close 會丟例外，忽略


async def broadcast_ws(msg_dict: dict):
    """將訊息廣播給所有活躍的 WebSocket 連接"""
    import json
    message = json.dumps(msg_dict)
    for conn in list(active_connections):
        try:
            await conn.send_text(message)
        except Exception:
            await drop_connection(conn)
