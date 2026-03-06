"""
routers/orders.py — 訂單相關 API 路由

包含：下單、刪單、改單、平倉、反手、委託快照
"""
import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from shioaji.constant import (
    Action, OrderType,
    StockPriceType, FuturesPriceType,
    StockOrderLot, StockOrderCond,
)
from backend import shared

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["orders"])


# ─── Request Models ────────────────────────────────────────

class PlaceOrderRequest(BaseModel):
    symbol: str
    price: float
    action: str  # "Buy" 或 "Sell"
    qty: int
    order_type: str = "ROD"
    price_type: str = "LMT"
    order_cond: str = "Cash"
    order_lot: str = "Common"

class CancelAllRequest(BaseModel):
    symbol: str
    action: str  # "Buy" 或 "Sell"

class UpdateOrderRequest(BaseModel):
    symbol: str
    action: str
    old_price: float
    new_price: float
    qty: int = None

class SymbolRequest(BaseModel):
    symbol: str


# ─── 內部工具 ──────────────────────────────────────────────

async def _get_working_orders_snapshot() -> list:
    """
    從 Shioaji 取得已確認的活躍委託快照。
    呼叫 update_status() 強制同步最新狀態後再查詢。
    """
    try:
        await shared.run_in_qt_thread(shared.shioaji_client.api.update_status)
        trades = await shared.run_in_qt_thread(shared.shioaji_client.get_order_history)
        active_statuses = {'PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled'}
        working = []
        for t in trades:
            status_name = t.status.status.name if hasattr(t.status, 'status') else getattr(t.status, 'name', 'Unknown')
            if status_name in active_statuses:
                raw_symbol = getattr(t.contract, 'symbol', '')
                if not raw_symbol:
                    raw_symbol = getattr(t.contract, 'code', '')
                working.append({
                    "symbol": raw_symbol,
                    "action": "Buy" if t.order.action == Action.Buy else "Sell",
                    "price": float(t.order.price),
                    "qty": t.order.quantity,
                    "filled_qty": getattr(t.status, 'deal_quantity', getattr(t.status, 'filled_quantity', 0)),
                    "status": status_name,
                    "order_id": getattr(t.order, 'id', getattr(t.order, 'seqno', '')),
                })
        return {"seq_no": shared.generate_order_seq(), "orders": working}
    except Exception as e:
        logger.error(f"_get_working_orders_snapshot 失敗: {e}")
        return {"seq_no": shared.generate_order_seq(), "orders": []}


# ─── 路由端點 ──────────────────────────────────────────────

@router.post("/place_order")
async def place_order(req: PlaceOrderRequest):
    """下單後回傳已確認的活躍委託快照"""
    action_val = Action.Buy if req.action.lower() == "buy" else Action.Sell

    order_type_map = {"ROD": OrderType.ROD, "IOC": OrderType.IOC, "FOK": OrderType.FOK}
    order_type_val = order_type_map.get(req.order_type.upper(), OrderType.ROD)

    stock_price_type_map = {"LMT": StockPriceType.LMT, "MKT": StockPriceType.MKT, "MKP": StockPriceType.MKP}
    futures_price_type_map = {"LMT": FuturesPriceType.LMT, "MKT": FuturesPriceType.MKT, "MKP": FuturesPriceType.MKP}

    order_cond_map = {"Cash": StockOrderCond.Cash, "MarginTrading": StockOrderCond.MarginTrading, "ShortSelling": StockOrderCond.ShortSelling}
    order_cond_val = order_cond_map.get(req.order_cond, StockOrderCond.Cash)

    order_lot_map = {"Common": StockOrderLot.Common, "Odd": StockOrderLot.Odd, "IntradayOdd": StockOrderLot.IntradayOdd, "Fixing": StockOrderLot.Fixing}
    order_lot_val = order_lot_map.get(req.order_lot, StockOrderLot.Common)

    # 判斷商品類型以決定 PriceType
    if len(req.symbol) == 4 and req.symbol.isdigit():
        price_type_val = stock_price_type_map.get(req.price_type.upper(), StockPriceType.LMT)
    else:
        price_type_val = futures_price_type_map.get(req.price_type.upper(), FuturesPriceType.LMT)

    trade = await shared.run_in_qt_thread(
        shared.shioaji_client.place_order,
        symbol=req.symbol, price=req.price, action=action_val, qty=req.qty,
        order_type=order_type_val, price_type=price_type_val,
        order_lot=order_lot_val, order_cond=order_cond_val
    )

    if trade:
        snapshot = await _get_working_orders_snapshot()
        return {"status": "success", "message": "下單成功", "data": snapshot}
    else:
        raise HTTPException(status_code=400, detail="下單失敗，請確認標的或庫存是否正確。")


@router.post("/update_order")
async def update_order(req: UpdateOrderRequest):
    """改單指令"""
    action_val = Action.Buy if req.action.lower() == "buy" else Action.Sell
    success = await shared.run_in_qt_thread(
        shared.shioaji_client.update_order,
        symbol=req.symbol, action=action_val,
        old_price=req.old_price, new_price=req.new_price, qty=req.qty
    )
    if success:
        return {"status": "success", "message": "改單指令已送出"}
    else:
        raise HTTPException(status_code=400, detail="改單失敗，找不到對應的委託。")


@router.post("/cancel_all")
async def cancel_all(req: CancelAllRequest):
    """刪單後回傳已確認的活躍委託快照"""
    action_val = Action.Buy if req.action.lower() == "buy" else Action.Sell
    try:
        cancel_count = await shared.run_in_qt_thread(shared.shioaji_client.cancel_all, req.symbol, action_val)
        snapshot = await _get_working_orders_snapshot()
        return {"status": "success", "message": f"成功送出 {cancel_count} 筆刪單指令", "data": snapshot}
    except Exception as e:
        logger.error(f"批次刪單失敗: {e}")
        raise HTTPException(status_code=500, detail="刪單過程遭遇錯誤")


@router.post("/flatten")
async def flatten_position(req: SymbolRequest):
    """一鍵平倉"""
    success = await shared.run_in_qt_thread(shared.shioaji_client.flatten_position, req.symbol)
    if success:
        return {"status": "success", "message": "一鍵平倉指令已送出"}
    else:
        raise HTTPException(status_code=400, detail="一鍵平倉失敗")


@router.post("/reverse")
async def reverse_position(req: SymbolRequest):
    """一鍵反向"""
    success = await shared.run_in_qt_thread(shared.shioaji_client.reverse_position, req.symbol)
    if success:
        return {"status": "success", "message": "一鍵反向指令已送出"}
    else:
        raise HTTPException(status_code=400, detail="一鍵反向失敗")


@router.get("/volume_profile")
async def get_volume_profile(symbol: str):
    """獲取指定商品的價量累積數據"""
    return shared.shioaji_client.volume_profile.get(symbol, {})
