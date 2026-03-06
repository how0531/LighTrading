"""
pnl_broadcaster.py — 即時損益廣播器

每秒計算所有持倉的即時 PnL 並透過 WebSocket 廣播。
"""
import asyncio
import json
import time as _time
import logging
from backend import shared

logger = logging.getLogger(__name__)

_PNL_MULTIPLIERS = {
    'TXF': 200, 'MXF': 50,
    'EXF': 4000,
    'GTF': 200,
}


def _get_multiplier(symbol: str) -> int:
    """根據商品代號回傳每點價值"""
    sym = symbol.upper()
    for prefix, mult in _PNL_MULTIPLIERS.items():
        if sym.startswith(prefix):
            return mult
    return 1000


async def pnl_broadcaster():
    """每秒計算所有持倉的即時 PnL 並廣播"""
    logger.info("★ PnL 廣播器已啟動")
    _cached_positions: list = []
    _pos_cache_time: float = 0.0
    POS_CACHE_TTL = 10.0

    while True:
        try:
            await asyncio.sleep(1)
            client = shared.shioaji_client
            if not client or not client._is_connected or not shared.active_connections:
                continue

            # 持倉快取：每 10 秒才重新查詢
            now = _time.monotonic()
            if now - _pos_cache_time > POS_CACHE_TTL:
                fresh = await shared.run_in_qt_thread(client.list_positions)
                if fresh:
                    _cached_positions = fresh
                    _pos_cache_time = now

            positions = _cached_positions
            if not positions:
                continue

            latest_prices = client._latest_prices
            realtime_positions = []
            total_pnl = 0
            total_realized = 0

            for pos in positions:
                symbol = pos.get('symbol', '')
                qty = pos.get('qty', 0) or pos.get('raw_qty', 0)
                cost = pos.get('price', 0)
                pnl_from_broker = pos.get('pnl', 0)
                direction = pos.get('direction', 'Buy')
                multiplier = _get_multiplier(symbol)

                cur_price = latest_prices.get(symbol, 0)
                if cur_price > 0 and cost > 0 and qty > 0:
                    sign = 1 if direction == 'Buy' else -1
                    pnl_per_unit = (cur_price - cost) * sign
                    rt_pnl = round(pnl_per_unit * qty * multiplier)
                else:
                    pnl_per_unit = 0
                    rt_pnl = pnl_from_broker

                total_pnl += rt_pnl
                total_realized += pos.get('pnl_realized', 0)
                realtime_positions.append({
                    **pos,
                    'realtimePnl': rt_pnl,
                    'pnlPerUnit': pnl_per_unit,
                    'currentPrice': cur_price,
                })

            msg = json.dumps({
                'type': 'PnLUpdate',
                'data': {
                    'positions': realtime_positions,
                    'total_pnl': total_pnl,
                    'total_realized': total_realized,
                }
            })
            
            async def _send_to_conn(conn):
                try:
                    await asyncio.wait_for(conn.send_text(msg), timeout=0.2)
                except Exception:
                    shared.active_connections.discard(conn)
                    
            if shared.active_connections:
                tasks = [_send_to_conn(c) for c in list(shared.active_connections)]
                await asyncio.gather(*tasks, return_exceptions=True)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"PnL 廣播器錯誤: {e}")
            await asyncio.sleep(2)


async def subscribe_position_contracts():
    """登入後自動訂閱所有持倉商品的報價"""
    try:
        client = shared.shioaji_client
        positions = await shared.run_in_qt_thread(client.list_positions)
        symbols = list({p['symbol'] for p in positions if p.get('symbol')})
        logger.info(f"★ 自動訂閱持倉商品報價: {symbols}")
        for sym in symbols:
            try:
                await shared.run_in_qt_thread(client.subscribe_background, sym)
                logger.info(f"  ✓ 已訂閱: {sym}")
            except Exception as e:
                logger.warning(f"  ✗ 訂閱 {sym} 失敗: {e}")
    except Exception as e:
        logger.error(f"subscribe_position_contracts 失敗: {e}")
