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
  OCO        → SmartOrderEngine.add_oco    （停利停損二擇一，需 take_profit_price + stop_loss_price）
  BRACKET    → SmartOrderEngine.add_bracket（限價進場 + 成交後自動掛 OCO，需 entry_price + TP + SL）
  CHASE      → SmartOrderEngine.add_chase  （追價智慧單：掛最佳對手價、不利移動時 cancel-replace 追價）
"""
import logging
from typing import Optional, Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from backend import shared

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["smart_orders"])

# CHASE 契約預設值 / 下限（與前端並行開發的欄位契約，名稱不可改）
_CHASE_DEFAULT_MAX_TICKS = 10
_CHASE_DEFAULT_REPRICE_TICKS = 1
_CHASE_DEFAULT_INTERVAL_MS = 1500
_CHASE_MIN_INTERVAL_MS = 500
_CHASE_FINAL_ACTIONS = ("GIVE_UP", "MARKET")


# ─── Request Models ────────────────────────────────────────

class SmartOrderRequest(BaseModel):
    """前端送來的 schema，支援多種觸發模式
    - STOP/MIT： trigger_price + trigger_condition（'>='|'<='|'price_gte'|'price_lte'）
    - TRAILING：trailing_offset > 0
    - CHASE：  max_chase_ticks / reprice_ticks / reprice_interval_ms / final_action
    為向後相容，stop_price 是 trigger_price 的 alias；
    quantity 是 qty 的 alias（CHASE 契約用 quantity）
    """
    symbol: str = Field(min_length=2, max_length=12)
    action: Literal["Buy", "Sell", "buy", "sell"]
    qty: Optional[int] = Field(default=None, gt=0, le=10000)
    quantity: Optional[int] = Field(default=None, gt=0, le=10000)  # alias of qty（CHASE 契約欄位）
    order_type: Optional[str] = None        # STOP / MIT / TRAILING / OCO / BRACKET / CHASE（不給就推斷）
    trigger_price: Optional[float] = None
    stop_price: Optional[float] = None      # alias of trigger_price
    trigger_condition: Optional[str] = None
    trailing_offset: float = 0
    # OCO / Bracket 用
    take_profit_price: float = 0
    stop_loss_price: float = 0
    entry_price: float = 0                   # Bracket 進場限價
    # CHASE 用（契約欄位名，不可改）
    max_chase_ticks: Optional[int] = None    # 相對初始掛價最大追價距離（tick），預設 10
    reprice_ticks: Optional[int] = None      # 落後最佳對手價 ≥ 此 tick 數才改價，預設 1
    reprice_interval_ms: Optional[int] = None  # 兩次改價最小間隔，預設 1500，下限 500
    final_action: Optional[str] = None       # GIVE_UP | MARKET，預設 GIVE_UP


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


def _validate_chase(req: SmartOrderRequest) -> dict:
    """驗證 CHASE 參數，回傳補上預設值後的 kwargs；非法值丟結構化 422。"""
    max_chase_ticks = req.max_chase_ticks if req.max_chase_ticks is not None \
        else _CHASE_DEFAULT_MAX_TICKS
    reprice_ticks = req.reprice_ticks if req.reprice_ticks is not None \
        else _CHASE_DEFAULT_REPRICE_TICKS
    reprice_interval_ms = req.reprice_interval_ms if req.reprice_interval_ms is not None \
        else _CHASE_DEFAULT_INTERVAL_MS
    final_action = (req.final_action or "GIVE_UP").strip().upper()

    if max_chase_ticks < 1:
        raise HTTPException(status_code=422, detail={
            "code": "INVALID_CHASE", "user_msg": "max_chase_ticks 必須 ≥ 1",
        })
    if reprice_ticks < 1:
        raise HTTPException(status_code=422, detail={
            "code": "INVALID_CHASE", "user_msg": "reprice_ticks 必須 ≥ 1",
        })
    if reprice_interval_ms < _CHASE_MIN_INTERVAL_MS:
        raise HTTPException(status_code=422, detail={
            "code": "INVALID_CHASE",
            "user_msg": f"reprice_interval_ms 下限為 {_CHASE_MIN_INTERVAL_MS}",
        })
    if final_action not in _CHASE_FINAL_ACTIONS:
        raise HTTPException(status_code=422, detail={
            "code": "INVALID_CHASE", "user_msg": "final_action 只能是 GIVE_UP 或 MARKET",
        })
    return {
        "max_chase_ticks": max_chase_ticks,
        "reprice_ticks": reprice_ticks,
        "reprice_interval_ms": reprice_interval_ms,
        "final_action": final_action,
    }


def _create_smart_order(req: SmartOrderRequest):
    action_val = "Buy" if req.action.lower() == "buy" else "Sell"
    engine = getattr(shared.engine, "smart_order_engine", None)
    if engine is None:
        raise HTTPException(status_code=503, detail={
            "code": "ENGINE_UNAVAILABLE", "user_msg": "智慧單引擎尚未啟動"
        })

    # qty / quantity 二擇一（CHASE 契約用 quantity；其他型別沿用 qty）
    qty_val = req.qty if req.qty is not None else req.quantity
    if qty_val is None:
        raise HTTPException(status_code=422, detail={
            "code": "INVALID_QTY", "user_msg": "需要 quantity（或 qty）> 0"
        })

    # 決定 order_type
    ot = (req.order_type or "").strip().upper()

    # CHASE：立即掛最佳對手價 + 追價
    if ot == "CHASE":
        chase_kwargs = _validate_chase(req)
        order = engine.add_chase(
            symbol=req.symbol, action=action_val, qty=qty_val, **chase_kwargs,
        )
        if order is None:
            raise HTTPException(status_code=422, detail={
                "code": "NO_QUOTE",
                "user_msg": "取不到該商品報價，無法決定追價掛價（請先訂閱行情）",
            })
        if order.chase_status == "RISK_BLOCKED":
            raise HTTPException(status_code=422, detail={
                "code": "RISK_BLOCK", "user_msg": "追價單進場被風控攔下",
            })
        if order.chase_status == "FAILED":
            raise HTTPException(status_code=502, detail={
                "code": "CHASE_ENTRY_FAILED", "user_msg": "追價單進場下單失敗，請稍後再試",
            })
        return {"status": "success", "message": "追價單已掛出", "id": order.id,
                "chase_price": order.chase_price}

    # OCO：停利停損二擇一
    if ot == "OCO":
        if req.take_profit_price <= 0 or req.stop_loss_price <= 0:
            raise HTTPException(status_code=422, detail={
                "code": "INVALID_OCO",
                "user_msg": "OCO 需要 take_profit_price 與 stop_loss_price 都 > 0",
            })
        oco_id = engine.add_oco(
            symbol=req.symbol, action=action_val, qty=qty_val,
            take_profit=req.take_profit_price, stop_loss=req.stop_loss_price,
        )
        return {"status": "success", "message": "OCO 停利停損已設定", "id": oco_id}

    # Bracket：限價進場 + 成交後自動掛 OCO
    if ot == "BRACKET":
        if req.entry_price <= 0 or req.take_profit_price <= 0 or req.stop_loss_price <= 0:
            raise HTTPException(status_code=422, detail={
                "code": "INVALID_BRACKET",
                "user_msg": "Bracket 需要 entry_price / take_profit_price / stop_loss_price 都 > 0",
            })
        bracket_id = engine.add_bracket(
            symbol=req.symbol, action=action_val, qty=qty_val,
            entry_price=req.entry_price,
            take_profit=req.take_profit_price, stop_loss=req.stop_loss_price,
        )
        return {"status": "success", "message": "Bracket 單已送出進場", "id": bracket_id}

    is_trailing = ot == "TRAILING" or req.trailing_offset > 0
    if is_trailing:
        if req.trailing_offset <= 0:
            raise HTTPException(status_code=422, detail={
                "code": "INVALID_TRAILING", "user_msg": "移動停損需要 trailing_offset > 0"
            })
        order = engine.add_trailing_stop(
            symbol=req.symbol, action=action_val,
            qty=qty_val, trailing_offset=req.trailing_offset,
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
            qty=qty_val, trigger_price=trigger, condition=cond,
        )
    return {"status": "success", "message": "智慧單已設定", "id": order.id}


@router.post("/smart_orders")
async def create_smart_order(req: SmartOrderRequest):
    """REST：新增智慧單"""
    return await shared.run_in_broker_thread(_create_smart_order, req)


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
