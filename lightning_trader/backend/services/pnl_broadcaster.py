"""
pnl_broadcaster.py — 即時損益廣播器（event-driven）

原本是 1 秒輪詢；改成：
  - 收到 tick 立即計算 PnL → debounce 100ms → 廣播
  - 收到 Filled 立即作廢持倉快取（下一筆 tick 會以新部位重算）
  - 同時保留 1.5s heartbeat：在沒 tick 的閒置時段，前端的 stale 燈號才有依據

PnL 計算邏輯：
  - 持倉的 symbol、_latest_prices 的 key 都已經由 SymbolResolver 統一成 canonical，
    因此不會再出現「期貨拿不到 latest price」的問題。
"""
import asyncio
import json
import time as _time
import logging
from backend import shared

logger = logging.getLogger(__name__)

from backend.services.contract_specs import get_multiplier as _get_multiplier  # noqa: E402,F401 (乘數表唯一來源)

# 持倉快取相關
_pos_cache: list = []
_pos_cache_time: float = 0.0
POS_CACHE_TTL = 1.0           # 1 秒 (原本 10 秒)
_invalidate_event = asyncio.Event()   # Filled 觸發；下一次計算前強制重抓

# Tick 事件觸發
_tick_event = asyncio.Event()

# Debounce 與心跳
_DEBOUNCE_MS = 100
_HEARTBEAT_S = 1.5


def on_tick_event(symbol: str, tick_data: dict) -> None:
    """EventBus.on_tick 的同步 handler — 設一個 asyncio.Event，喚醒廣播 loop。"""
    loop = shared.fastapi_loop
    if loop:
        loop.call_soon_threadsafe(_tick_event.set)


def on_fill_event(order_msg: dict = None) -> None:
    """成交回報：作廢持倉快取，並喚醒廣播 loop 立即重算。"""
    loop = shared.fastapi_loop
    if loop:
        loop.call_soon_threadsafe(_invalidate_event.set)
        loop.call_soon_threadsafe(_tick_event.set)


async def _refresh_positions_if_stale() -> list:
    """依 TTL 或 invalidate 旗標決定是否重新拉持倉。"""
    global _pos_cache, _pos_cache_time
    now = _time.monotonic()
    forced = _invalidate_event.is_set()
    if forced or (now - _pos_cache_time > POS_CACHE_TTL):
        try:
            fresh = await shared.run_in_broker_thread(shared.shioaji_client.list_positions)
            if fresh is not None:
                _pos_cache = fresh
                _pos_cache_time = now
        except Exception as e:
            logger.warning(f"refresh positions 失敗: {e}")
        if forced:
            _invalidate_event.clear()
    return _pos_cache


def _compute_pnl_payload() -> dict:
    """從 _latest_prices + 快取持倉 → PnL payload"""
    client = shared.shioaji_client
    latest_prices = getattr(client, "_latest_prices", {})
    rt_positions = []
    total_pnl = 0
    total_realized = 0
    for pos in _pos_cache:
        symbol = pos.get("symbol", "")
        qty = pos.get("qty", 0) or pos.get("raw_qty", 0)
        cost = pos.get("price", 0)
        pnl_from_broker = pos.get("pnl", 0)
        direction = pos.get("direction", "Buy")
        multiplier = _get_multiplier(symbol)
        cur_price = latest_prices.get(symbol, 0)
        if cur_price > 0 and cost > 0 and qty > 0:
            sign = 1 if direction == "Buy" else -1
            pnl_per_unit = (cur_price - cost) * sign
            rt_pnl = round(pnl_per_unit * qty * multiplier)
        else:
            pnl_per_unit = 0
            rt_pnl = pnl_from_broker
        total_pnl += rt_pnl
        total_realized += pos.get("pnl_realized", 0)
        rt_positions.append({
            **pos,
            "realtimePnl": rt_pnl,
            "pnlPerUnit": pnl_per_unit,
            "currentPrice": cur_price,
        })
    return {
        "positions": rt_positions,
        "total_pnl": total_pnl,
        "total_realized": total_realized,
    }


_HEARTBEAT_MSG = json.dumps({"type": "Heartbeat"})
_HEARTBEAT_EVERY_S = 3.0


async def heartbeat_loop():
    """
    獨立的 WS 心跳 task（main.py lifespan 啟動）。

    前端 stale watchdog 需要穩定的訊息流，才能把「盤後/未登入沒行情
    （正常）」與「連線假死（要強制重連）」分開。必須獨立於 pnl 迴圈 ——
    pnl 迴圈會 await 排在 broker 執行緒上的 list_positions，一個慢的
    券商呼叫（30 天 kbars、全商品搜尋）就能讓內嵌心跳停發 >12 秒，
    前端反而把健康的連線誤判成假死、強制重連。
    """
    logger.info("★ WS 心跳已啟動（每 %.0fs）" % _HEARTBEAT_EVERY_S)
    while True:
        try:
            await asyncio.sleep(_HEARTBEAT_EVERY_S)
            if not shared.active_connections:
                continue
            for conn in list(shared.active_connections):
                try:
                    await asyncio.wait_for(conn.send_text(_HEARTBEAT_MSG), timeout=1.0)
                except Exception:
                    await shared.drop_connection(conn)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"heartbeat_loop 錯誤: {e}")
            await asyncio.sleep(1)


def _feed_risk_manager(payload: dict) -> None:
    """把即時未實現損益 + 持倉快照餵給 RiskManager（日虧損熔斷的資料源）。"""
    rm = getattr(shared.engine, "risk_manager", None) if shared.engine else None
    if rm is None:
        return
    try:
        rm.update_positions(payload.get("positions", []))
        rm.update_daily_pnl(unrealized=payload.get("total_pnl", 0))
    except Exception as e:
        logger.warning(f"feed risk manager 失敗: {e}")


async def _broadcast_pnl(payload: dict):
    """把目前 payload 廣播給所有 WebSocket 客戶端"""
    if not shared.active_connections:
        return
    msg = json.dumps({"type": "PnLUpdate", "data": payload})
    async def _send(conn):
        try:
            await asyncio.wait_for(conn.send_text(msg), timeout=1.0)
        except Exception:
            # 移除 + 真正關閉，讓客戶端 onclose 觸發自動重連（見 shared.drop_connection）
            await shared.drop_connection(conn)
    tasks = [_send(c) for c in list(shared.active_connections)]
    await asyncio.gather(*tasks, return_exceptions=True)


async def pnl_broadcaster():
    """
    主迴圈：
      - 等待 tick 事件 / 心跳逾時 → 計算 PnL → 廣播
      - tick 事件後 debounce 100ms，避免高頻 tick 引發每 ms 一次廣播
    """
    logger.info("★ PnL 廣播器已啟動 (event-driven, TTL=%.1fs, debounce=%dms)" % (POS_CACHE_TTL, _DEBOUNCE_MS))
    while True:
        try:
            try:
                await asyncio.wait_for(_tick_event.wait(), timeout=_HEARTBEAT_S)
            except asyncio.TimeoutError:
                pass
            # debounce：再等 100ms 看是否還有 tick；有的話一起合併
            _tick_event.clear()
            await asyncio.sleep(_DEBOUNCE_MS / 1000.0)
            _tick_event.clear()

            client = shared.shioaji_client
            if not client or not getattr(client, "_is_connected", False):
                continue

            await _refresh_positions_if_stale()
            payload = _compute_pnl_payload()
            # ★ 風控餵入不依賴 WS 連線、也不依賴「有持倉」——
            #   全部平倉後 payload 為 {positions: [], total_pnl: 0}，
            #   必須把未實現損益歸零，否則熔斷會拿「已實現 + 凍結的舊未實現」重複計算
            _feed_risk_manager(payload)
            if not _pos_cache:
                continue
            await _broadcast_pnl(payload)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"PnL 廣播器錯誤: {e}", exc_info=True)
            await asyncio.sleep(1)


async def subscribe_position_contracts():
    """登入後／新成交後自動訂閱所有持倉商品的報價"""
    try:
        client = shared.shioaji_client
        positions = await shared.run_in_broker_thread(client.list_positions)
        symbols = list({p['symbol'] for p in positions if p.get('symbol')})
        logger.info(f"★ 自動訂閱持倉商品報價: {symbols}")
        for sym in symbols:
            try:
                await shared.run_in_broker_thread(client.subscribe_background, sym)
                logger.info(f"  ✓ 已訂閱: {sym}")
            except Exception as e:
                logger.warning(f"  ✗ 訂閱 {sym} 失敗: {e}")
    except Exception as e:
        logger.error(f"subscribe_position_contracts 失敗: {e}")
