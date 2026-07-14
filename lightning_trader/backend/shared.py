"""
shared.py — 後端共用狀態與工具

所有 routers / services 從此處 import 共用的單例與工具函式，
避免循環引用和全域變數散落在 main.py 中。
"""
import asyncio
import collections
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


# ─── 廣播佇列：關鍵回報 / 純報價分流 + 背壓（WS5-D3）────────────
# 問題：舊版 quotes_to_broadcast 是「無界」asyncio.Queue，且把關鍵回報
#   （OrderUpdate/TradeUpdate/SmartOrderUpdate/…）與純報價（Tick/BidAsk）
#   塞在同一條佇列。慢客戶端下：
#     1. 佇列無上限 → 記憶體隨報價無限成長。
#     2. 關鍵回報夾在大量報價後面 → 成交/委託狀態延遲送達前端。
#
# 修法（型別/格式對前端完全不變，只改排程與背壓）：
#   - 兩條內部佇列：
#       critical（無界，永不丟）：除 Tick/BidAsk 外的所有訊息。
#       quotes  （有界 maxsize，drop-oldest）：Tick / BidAsk。
#   - 取用時「關鍵優先」：get() / get_nowait() 一律先出 critical 再出 quotes。
#   - quotes 滿時丟「最舊」的一筆（報價可丟舊、關鍵不可丟）。
#
# 對外仍暴露 asyncio.Queue 風格介面（put_nowait / get / get_nowait / empty），
# producer（bridge / order_sync）與既有測試無需改動。
_QUOTE_TYPES = frozenset({"Tick", "BidAsk"})
# 有界報價佇列上限：足以吸收突發，又不至於在慢客戶端下無限成長。
QUOTE_QUEUE_MAXSIZE = 2000


class BroadcastQueue:
    """關鍵回報優先 + 報價有界背壓的雙佇列。介面相容 asyncio.Queue 子集。"""

    def __init__(self, quote_maxsize: int = QUOTE_QUEUE_MAXSIZE):
        self._critical: "collections.deque" = collections.deque()
        self._quotes: "collections.deque" = collections.deque()
        self._quote_maxsize = int(quote_maxsize)
        self._not_empty = asyncio.Event()
        # 觀測用計數（測試/監控可讀）
        self.dropped_quotes = 0

    # ── 分類 ──
    @staticmethod
    def _is_quote(item) -> bool:
        return isinstance(item, dict) and item.get("type") in _QUOTE_TYPES

    # ── 寫入 ──
    def put_nowait(self, item) -> None:
        """放入一筆訊息。報價滿佇列時丟最舊的一筆（drop-oldest）；關鍵永不丟。"""
        if self._is_quote(item):
            if len(self._quotes) >= self._quote_maxsize:
                # drop-oldest：丟掉最舊的報價，換上最新的，佇列長度維持上限
                self._quotes.popleft()
                self.dropped_quotes += 1
            self._quotes.append(item)
        else:
            self._critical.append(item)
        self._not_empty.set()

    # asyncio.Queue 相容別名（put 在無界語意下等同 put_nowait）
    def put_nowait_quote(self, item) -> None:  # 明確語意的便捷入口（可選）
        self.put_nowait(item)

    # ── 讀取 ──
    def _pop_priority(self):
        """關鍵優先取一筆；兩條都空則 raise asyncio.QueueEmpty。"""
        if self._critical:
            return self._critical.popleft()
        if self._quotes:
            return self._quotes.popleft()
        raise asyncio.QueueEmpty

    def get_nowait(self):
        item = self._pop_priority()
        if self.empty():
            self._not_empty.clear()
        return item

    def pop_critical_nowait(self):
        """只取關鍵回報；沒有關鍵回報則 raise asyncio.QueueEmpty（不動報價）。"""
        if self._critical:
            item = self._critical.popleft()
            if self.empty():
                self._not_empty.clear()
            return item
        raise asyncio.QueueEmpty

    async def get(self):
        """阻塞取一筆，關鍵回報優先。"""
        while self.empty():
            self._not_empty.clear()
            # 單執行緒事件迴圈語意：check→clear→await 之間不會被 producer 搶插，
            # producer 的 put 只會在此處 await 讓出時執行並重新 set，不會遺失喚醒。
            await self._not_empty.wait()
        return self.get_nowait()

    # ── 狀態查詢 ──
    def empty(self) -> bool:
        return not self._critical and not self._quotes

    def critical_empty(self) -> bool:
        return not self._critical

    def qsize(self) -> int:
        return len(self._critical) + len(self._quotes)

    def critical_qsize(self) -> int:
        return len(self._critical)

    def quote_qsize(self) -> int:
        return len(self._quotes)

    def stats(self) -> dict:
        return {
            "critical": len(self._critical),
            "quotes": len(self._quotes),
            "quote_maxsize": self._quote_maxsize,
            "dropped_quotes": self.dropped_quotes,
        }


# Shioaji → WebSocket 的報價/回報佇列（關鍵優先 + 報價有界背壓）
quotes_to_broadcast: BroadcastQueue = BroadcastQueue()

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
