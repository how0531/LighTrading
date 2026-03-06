"""
routers/smart.py — 智慧單相關 API 路由

包含：新增智慧單、查詢智慧單、取消智慧單
"""
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from backend import shared

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["smart_orders"])


# ─── Request Models ────────────────────────────────────────

class SmartOrderRequest(BaseModel):
    symbol: str
    action: str
    qty: int
    stop_price: float = 0
    trailing_offset: float = 0

class CancelSmartOrderRequest(BaseModel):
    order_id: str


# ─── 路由端點 ──────────────────────────────────────────────

@router.post("/add_smart_order")
async def add_smart_order(req: SmartOrderRequest):
    """新增智慧單 (本地監控)，交由 SmartOrderEngine 洗價"""
    action_val = "Buy" if req.action.lower() == "buy" else "Sell"
    if req.trailing_offset > 0:
        await shared.run_in_qt_thread(
            shared.engine.smart_order_engine.add_trailing_stop,
            symbol=req.symbol, action=action_val,
            qty=req.qty, trailing_offset=req.trailing_offset
        )
    else:
        cond = "price_lte" if action_val == "Sell" else "price_gte"
        await shared.run_in_qt_thread(
            shared.engine.smart_order_engine.add_mit,
            symbol=req.symbol, action=action_val,
            qty=req.qty, trigger_price=req.stop_price, condition=cond
        )
    return {"status": "success", "message": "智慧單已設定"}


@router.get("/smart_orders")
async def get_smart_orders(symbol: str = None):
    """取得本地端啟用的智慧單"""
    return shared.engine.smart_order_engine.get_active_orders(symbol)


@router.post("/cancel_smart_order")
async def cancel_smart_order(req: CancelSmartOrderRequest):
    """取消指定的智慧單"""
    success = shared.engine.smart_order_engine.cancel(req.order_id)
    if success:
        return {"status": "success", "message": "智慧單已取消"}
    else:
        raise HTTPException(status_code=400, detail="找不到該智慧單或無法取消")
