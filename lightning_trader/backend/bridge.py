"""
bridge.py — Shioaji 回呼橋接層

將 ShioajiClient 的同步回呼轉接進 asyncio Queue，
供 quote_broadcaster / WebSocket 使用。

職責：
- on_shioaji_quote: Tick/BidAsk 格式化 → quotes_to_broadcast
- on_shioaji_account_update: 帳務摘要 → WebSocket
- on_shioaji_order_update: 訂單狀態 → WebSocket
- on_shioaji_trade_update: 成交回報 → WebSocket
- on_smart_order_update: 智慧單 → WebSocket
"""
import asyncio
import logging
from backend import shared

logger = logging.getLogger(__name__)


def on_shioaji_quote(quote_data: dict):
    """
    從 ShioajiClient 接收 Tick/BidAsk 報價，格式化後放入 asyncio 佇列。
    """
    try:
        q = quote_data.copy()

        def _val(v, default=0):
            if isinstance(v, (list, tuple)):
                return v[0] if len(v) > 0 else default
            return v if v is not None else default

        has_bidask = any(k in q for k in ["AskPrice", "BidPrice", "ask_price", "bid_price"])
        has_tick = any(k in q for k in ["Close", "close", "Price"])

        symbol = q.get("Symbol", "")
        items_to_send = []

        if has_bidask:
            bidask_data = {
                "Symbol": symbol,
                "AskPrice": [float(p) for p in q.get('AskPrice', q.get('ask_price', []))],
                "AskVolume": [int(v) for v in q.get('AskVolume', q.get('ask_volume', []))],
                "BidPrice": [float(p) for p in q.get('BidPrice', q.get('bid_price', []))],
                "BidVolume": [int(v) for v in q.get('BidVolume', q.get('bid_volume', []))],
                "DiffBidVol": q.get('DiffBidVol', q.get('diff_bid_vol', [])),
                "DiffAskVol": q.get('DiffAskVol', q.get('diff_ask_vol', [])),
                "Time": shared.format_datetime(q.get('Time', q.get('datetime', q.get('ts', ''))))
            }
            if any(bidask_data["AskPrice"]) or any(bidask_data["BidPrice"]):
                items_to_send.append({"type": "BidAsk", "data": bidask_data})

        if has_tick:
            p_val = float(_val(q.get('Close', q.get('close', q.get('Price', 0)))))
            v_val = int(_val(q.get('Volume', q.get('volume', 0))))

            tick_data = {
                "Symbol": symbol,
                "Price": p_val,
                "Volume": v_val,
                "Open": float(_val(q.get('Open', q.get('open', 0)))),
                "High": float(_val(q.get('High', q.get('high', 0)))),
                "Low": float(_val(q.get('Low', q.get('low', 0)))),
                "AvgPrice": float(_val(q.get('AvgPrice', q.get('avg_price', 0)))),
                "TickType": int(_val(q.get('TickType', q.get('tick_type', 0)))),
                "TickTime": shared.format_datetime(q.get('Time', q.get('TickTime', q.get('datetime', q.get('ts', ''))))),
                "Action": q.get('Action', q.get('action', ''))
            }
            ref = float(_val(q.get('Reference', q.get('reference', 0))))
            lu = float(_val(q.get('LimitUp', q.get('limit_up', 0))))
            ld = float(_val(q.get('LimitDown', q.get('limit_down', 0))))
            if ref > 0: tick_data["Reference"] = ref
            if lu > 0: tick_data["LimitUp"] = lu
            if ld > 0: tick_data["LimitDown"] = ld

            if p_val > 0 or ref > 0 or v_val > 0:
                items_to_send.append({"type": "Tick", "data": tick_data})

            # 發送給 EventBus 供洗價引擎使用
            if p_val > 0:
                try:
                    shared.engine.event_bus.on_tick.emit(symbol, tick_data)
                except Exception as e:
                    logger.error(f"EventBus emit on_tick error: {e}")

        for quote_item in items_to_send:
            if shared.fastapi_loop:
                shared.fastapi_loop.call_soon_threadsafe(shared.quotes_to_broadcast.put_nowait, quote_item)
            else:
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        loop.call_soon_threadsafe(shared.quotes_to_broadcast.put_nowait, quote_item)
                except:
                    pass

    except Exception as e:
        logger.error(f"處理 Shioaji 報價並放入佇列時發生錯誤: {e}")


def on_shioaji_account_update(summary_data: dict):
    """帳務摘要推播"""
    try:
        quote_item = {"type": "AccountUpdate", "data": summary_data}
        if shared.fastapi_loop:
            shared.fastapi_loop.call_soon_threadsafe(shared.quotes_to_broadcast.put_nowait, quote_item)
    except Exception as e:
        logger.error(f"廣播帳戶更新時發生錯誤: {e}")


def on_shioaji_order_update(order_msg: dict):
    """訂單狀態推播"""
    try:
        msg_item = {
            "type": "OrderUpdate", 
            "data": order_msg,
            "seq_no": shared.generate_order_seq()
        }
        if shared.fastapi_loop:
            shared.fastapi_loop.call_soon_threadsafe(shared.quotes_to_broadcast.put_nowait, msg_item)
    except Exception as e:
        logger.error(f"廣播訂單狀態更新時發生錯誤: {e}")


def on_shioaji_trade_update(trade_data: dict):
    """成交回報推播"""
    try:
        msg_item = {"type": "TradeUpdate", "data": trade_data}
        if shared.fastapi_loop:
            shared.fastapi_loop.call_soon_threadsafe(shared.quotes_to_broadcast.put_nowait, msg_item)
    except Exception as e:
        logger.error(f"廣播交易回報時發生錯誤: {e}")


def on_smart_order_update(order_data: dict):
    """智慧單推播"""
    try:
        msg_item = {"type": "SmartOrderUpdate", "data": order_data}
        if shared.fastapi_loop:
            shared.fastapi_loop.call_soon_threadsafe(shared.quotes_to_broadcast.put_nowait, msg_item)
    except Exception as e:
        logger.error(f"廣播智慧單回報時發生錯誤: {e}")


def wire_callbacks():
    """
    連接所有 Shioaji 回呼。在 main.py 初始化 engine 後呼叫一次。
    """
    client = shared.shioaji_client
    eng = shared.engine

    # 帳戶/訂單訊號仍使用 Qt Signal（低頻）
    client.signal_account_update.connect(on_shioaji_account_update)
    client.signal_order_update.connect(on_shioaji_order_update)
    client.signal_trade_update.connect(on_shioaji_trade_update)
    eng.event_bus.on_smart_order_added.connect(on_smart_order_update)
    eng.event_bus.on_smart_order_triggered.connect(on_smart_order_update)

    # 高頻報價使用直接回呼（繞過 Qt Signal）
    client._direct_quote_callback = on_shioaji_quote
    logger.info("✅ bridge: 已連接所有 Shioaji 回呼")
