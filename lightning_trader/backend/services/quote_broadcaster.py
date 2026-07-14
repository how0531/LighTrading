"""
quote_broadcaster.py — 報價廣播器

從 asyncio Queue 取出格式化的報價項目，
廣播給所有活躍的 WebSocket 連接。
"""
import asyncio
import json
import logging
from backend import shared
from backend.shared import BroadcastQueue

logger = logging.getLogger(__name__)


async def _send_one(item: dict) -> None:
    """把單一訊息廣播給所有活躍連線（型別/格式對前端完全不變）。"""
    if not item or not shared.active_connections:
        return
    message = json.dumps(item)

    async def _send_to_conn(conn):
        try:
            # Timeout 防呆，避免單一慢客戶端卡死整個廣播迴圈。
            # 注意不能太短：瀏覽器分頁切背景（timer throttling）/ GC /
            # 網路抖動都常超過 100ms —— 之前設 0.1s 導致正常客戶端
            # 被誤踢成殭屍連線（見 shared.drop_connection 說明）
            await asyncio.wait_for(conn.send_text(message), timeout=1.0)
        except Exception as e:
            logger.info(f"WebSocket 斷開或送出逾時，移除並關閉連線: {e}")
            await shared.drop_connection(conn)

    tasks = [_send_to_conn(c) for c in list(shared.active_connections)]
    await asyncio.gather(*tasks, return_exceptions=True)


async def quote_broadcaster():
    """從佇列取出訊息並廣播給 WebSocket 客戶端。

    WS5-D3：關鍵回報（OrderUpdate/TradeUpdate/…）與純報價（Tick/BidAsk）已在
    shared.BroadcastQueue 分流。每次醒來「先把當前所有關鍵回報排空」再處理這筆
    報價，確保慢客戶端下關鍵回報永遠優先送達、不被大量報價夾住。
    """
    logger.info("報價廣播器已啟動")
    q = shared.quotes_to_broadcast

    while True:
        try:
            # get() 本身即關鍵優先；醒來後先把已就緒的關鍵回報全部先清空
            item = await q.get()
            batch = []
            if BroadcastQueue._is_quote(item):
                # 把此刻已到的關鍵回報全部先排到最前
                while True:
                    try:
                        batch.append(q.pop_critical_nowait())
                    except asyncio.QueueEmpty:
                        break
                batch.append(item)
            else:
                # item 已是關鍵回報：連同其餘關鍵回報一次排空，報價留待下一輪
                batch.append(item)
                while True:
                    try:
                        batch.append(q.pop_critical_nowait())
                    except asyncio.QueueEmpty:
                        break

            for it in batch:
                await _send_one(it)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"報價廣播器錯誤: {e}")
            await asyncio.sleep(0.1)
