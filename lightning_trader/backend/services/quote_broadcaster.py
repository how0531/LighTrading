"""
quote_broadcaster.py — 報價廣播器

從 asyncio Queue 取出格式化的報價項目，
廣播給所有活躍的 WebSocket 連接。
"""
import asyncio
import json
import logging
from backend import shared

logger = logging.getLogger(__name__)


async def quote_broadcaster():
    """從報價佇列取出報價並廣播給 WebSocket 客戶端"""
    logger.info("報價廣播器已啟動")

    while True:
        try:
            quote_data = await shared.quotes_to_broadcast.get()
            if quote_data:
                message = json.dumps(quote_data)
                
                async def _send_to_conn(conn):
                    try:
                        # 加上 0.1 秒的 Timeout 防呆，避免單一慢客戶端卡死整個廣播迴圈
                        await asyncio.wait_for(conn.send_text(message), timeout=0.1)
                    except Exception as e:
                        # TimeoutError 或 WebSocketConnectionClosedException
                        shared.active_connections.discard(conn)
                        logger.info(f"WebSocket 斷開或超時，已移除連線: {e}")

                if shared.active_connections:
                    tasks = [_send_to_conn(c) for c in list(shared.active_connections)]
                    await asyncio.gather(*tasks, return_exceptions=True)
                    
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"報價廣播器錯誤: {e}")
            await asyncio.sleep(0.1)
