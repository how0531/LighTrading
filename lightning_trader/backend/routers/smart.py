"""
routers/smart.py — 智慧單相關 API 路由

REST：
  POST   /api/smart_orders             新增
  GET    /api/smart_orders             列出活躍智慧單
  DELETE /api/smart_orders/{order_id}  取消
  POST   /api/smart_orders/cancel_all  取消全部（依 symbol 可選）

支援的 order_type：
  STOP       → SmartOrderEngine.add_mit   （觸價單 / 停損）
  MIT        → 同 STOP（語意不同但實作同）
  TRAILING   → SmartOrderEngine.add_trailing_stop
"""
import logging
from typing import Optional, Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from backend import shared

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["smart_orders"])


# ─── Request Models ────────────────────────────────────────

class SmartOrderRequest(BaseModel):
    """前端送來的 schema，支援多種觸發模式
    - STOP/MIT： trigger_price + trigger_condition（'>='|'<='|'price_gte'|'price_lte'）
    - TRAILING：trailing_offset > 0
    為向後相容，stop_price 是 trigger_price 的 alias
    """
    symbol: str = Field(min_length=2, max_length=12)
    action: Literal["Buy", "Sell", "buy", "sell"]
    qty: int = Field(gt=0, le=10000)
    order_type: Optional[str] = None        # STOP / MIT / TRAILING（不給就推斷）
    trigger_price: Optional[float] = None
    stop_price: Optional[float] = None      # alias of trigger_price
    trigger_condition: Optional[str] = None
    trailing_offset: float = 0
    # 預留欄位（暫不使用，但接受不報錯）
    take_profit_price: float = 0
    stop_loss_price: float = 0


# ─── 路由端點 ──────────────────────────────────────────────

def _normalize_condition(cond: Optional[str], action: str) -> str:
    """把多種寫法統一成 engine 接受的 price_gte / price_lte"""
    if not cond:
        return "price_gte" if action.lower() == "buy" else "price_lte"
    c = cond.strip().lower()
    if c in (">=", "gte", "price_gte"):
        return "price_gte"
    if c in ("<=", "lte", "price_lte"):
        return "price_lte"
    return "price_gte" if action.lower() == "buy" else "price_lte"


def _create_smart_order(req: SmartOrderRequest):
    action_val = "Buy" if req.action.lower() == "buy" else "Sell"
    engine = getattr(shared.engine, "smart_order_engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail={
            "code": "ENGINE_UNAVAILABLE", "user_msg": "智慧單引擎尚未啟動"
        })

    # 決定 order_type
    ot = (req.order_type or "").strip().upper()
    is_trailing = ot == "TRAILING" or req.trailing_offset > 0
    if is_trailing:
        if req.trailing_offset <= 0:
            raise HTTPException(status_code=422, detail={
                "code": "INVALID_TRAILING", "user_msg": "移動停損需要 trailing_offset > 0"
            })
        order = engine.add_trailing_stop(
            symbol=req.symbol, action=action_val,
            qty=req.qty, trailing_offset=req.trailing_offset,
        )
    else:
        trigger = req.trigger_price if req.trigger_price is not None else req.stop_price
        if trigger is None or trigger <= 0:
            raise HTTPException(status_code=422, detail={
                "code": "INVALID_TRIGGER", "user_msg": "需要 trigger_price > 0"
            })
        cond = _normalize_condition(req.trigger_condition, action_val)
        order = engine.add_mit(
            symbol=req.symbol, action=action_val,
            qty=req.qty, trigger_price=trigger, condition=cond,
        )
    return {"status": "success", "message": "智慧單已設定", "id": order.id}


@router.post("/smart_orders")
async def create_smart_order(req: SmartOrderRequest):
    """REST：新增智慧單"""
    return await shared.run_in_qt_thread(_create_smart_order, req)


@router.get("/smart_orders")
async def list_smart_orders(symbol: Optional[str] = None):
    """列出活躍智慧單"""
    return shared.engine.smart_order_engine.get_active_orders(symbol)


@router.delete("/smart_orders/{order_id}")
async def cancel_smart_order(order_id: str):
    """REST：刪除指定智慧單"""
    success = shared.engine.smart_order_engine.cancel(order_id)
    if success:
        return {"status": "success", "message": "智慧單已取消", "id": order_id}
    raise HTTPException(status_code=404, detail={
        "code": "SMART_ORDER_NOT_FOUND", "user_msg": "找不到該智慧單"
    })


@router.post("/smart_orders/cancel_all")
async def cancel_all_smart_orders(symbol: Optional[str] = None):
    """批次取消（依 symbol 可選；不給代表所有 active 都取消）"""
    n = shared.engine.smart_order_engine.cancel_all(symbol)
    return {"status": "success", "cancelled": n}
