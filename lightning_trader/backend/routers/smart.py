"""
routers/smart.py — 智慧單相關 API 路由

包含：新增智慧單（MIT / Trailing / OCO / Bracket / Scale-out）、查詢、取消
"""
import logging
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
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


class OCORequest(BaseModel):
    symbol: str
    action: str = Field(description="平倉方向：多單平倉=Sell、空單平倉=Buy")
    qty: int = Field(gt=0)
    take_profit: float = Field(gt=0)
    stop_loss: float = Field(gt=0)


class BracketRequest(BaseModel):
    symbol: str
    action: str
    qty: int = Field(gt=0)
    entry_price: float = Field(gt=0)
    take_profit: float = Field(gt=0)
    stop_loss: float = Field(gt=0)


class ScaleOutTarget(BaseModel):
    price: float = Field(gt=0)
    qty: int = Field(gt=0)


class ScaleOutRequest(BaseModel):
    symbol: str
    action: str = Field(description="平倉方向：多單平倉=Sell、空單平倉=Buy")
    targets: List[ScaleOutTarget] = Field(min_length=1, max_length=5)
    stop_loss: float = Field(gt=0)
    runner_trailing: float = Field(default=0, ge=0, description=">0 時加一筆 trailing runner")


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


@router.post("/add_oco")
async def add_oco(req: OCORequest):
    """OCO：停利停損二擇一，任一觸發就取消另一個。"""
    action_val = "Buy" if req.action.lower() == "buy" else "Sell"
    main_id = await shared.run_in_qt_thread(
        shared.engine.smart_order_engine.add_oco,
        symbol=req.symbol, action=action_val, qty=req.qty,
        take_profit=req.take_profit, stop_loss=req.stop_loss,
    )
    return {"status": "success", "message": "OCO 已設定", "id": main_id}


@router.post("/add_bracket")
async def add_bracket(req: BracketRequest):
    """Bracket：限價進場單成交後自動掛 OCO 停利停損。"""
    action_val = "Buy" if req.action.lower() == "buy" else "Sell"
    bid = await shared.run_in_qt_thread(
        shared.engine.smart_order_engine.add_bracket,
        symbol=req.symbol, action=action_val, qty=req.qty,
        entry_price=req.entry_price,
        take_profit=req.take_profit, stop_loss=req.stop_loss,
    )
    return {"status": "success", "message": "Bracket 已設定", "id": bid}


@router.post("/add_scale_out")
async def add_scale_out(req: ScaleOutRequest):
    """
    Scale-out 分批出場：紀律交易者最常用的出場模板。

    範例 payload（多單 entry 17000，做 +5/+10 兩段出場 + runner）：
        {
          "symbol": "TXFR1", "action": "Sell",
          "targets": [{"price": 17005, "qty": 1}, {"price": 17010, "qty": 1}],
          "stop_loss": 16995, "runner_trailing": 20
        }
    """
    action_val = "Buy" if req.action.lower() == "buy" else "Sell"
    ids = await shared.run_in_qt_thread(
        shared.engine.smart_order_engine.add_scale_out,
        symbol=req.symbol,
        action=action_val,
        targets=[t.model_dump() for t in req.targets],
        stop_loss=req.stop_loss,
        runner_trailing=req.runner_trailing,
    )
    return {"status": "success", "ids": ids}


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
