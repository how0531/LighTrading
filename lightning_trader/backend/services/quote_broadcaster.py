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
                        # Timeout 防呆，避免單一慢客戶端卡死整個廣播迴圈。
                        # 注意不能太短：瀏覽器分頁切背景（timer throttling）/ GC /
                        # 網路抖動都常超過 100ms —— 之前設 0.1s 導致正常客戶端
                        # 被誤踢成殭屍連線（見 shared.drop_connection 說明）
                        await asyncio.wait_for(conn.send_text(message), timeout=1.0)
                    except Exception as e:
                        logger.info(f"WebSocket 斷開或送出逾時，移除並關閉連線: {e}")
                        await shared.drop_connection(conn)

                if shared.active_connections:
                    tasks = [_send_to_conn(c) for c in list(shared.active_connections)]
                    await asyncio.gather(*tasks, return_exceptions=True)
                    
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"報價廣播器錯誤: {e}")
            await asyncio.sleep(0.1)
