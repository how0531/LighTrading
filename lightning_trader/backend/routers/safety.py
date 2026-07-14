"""
routers/safety.py — 執行期安全網端點

  POST /api/panic          恐慌鈕：雙側全撤 + 全部持倉平倉 + 停用一切新單
  GET  /api/safety/health  安全健康列：熔斷狀態 / trading_enabled / 每日硬上限
                           計數 / 最近對帳落差 / 連線狀態

★ 為何不用 /api/health：既有 routers/health.py 已註冊 /api/health（liveness
  探針，先註冊者先匹配），再註冊同路徑會被遮蔽成死碼。故安全健康列改掛
  /api/safety/health，不覆蓋既有探針。

恐慌鈕只「組合既有能力」，不新造下單邏輯：
  - shioaji_client.cancel_all(symbol, action)   逐商品雙側撤單
  - shioaji_client.flatten_position(symbol)     逐商品反向市價平倉
  - risk_manager.config.trading_enabled = False 停用一切新單
  - smart_order_engine.cancel_all()             撤所有智慧單（best-effort）
"""
import logging
from fastapi import APIRouter
from backend import shared

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["safety"])


def _action_enum():
    """延後 import shioaji.constant，避免 module import 期硬依賴。"""
    from shioaji.constant import Action
    return Action


async def _symbols_with_working_orders() -> set:
    """取有活躍委託的商品集合（best-effort，失敗回空集合）。"""
    client = shared.shioaji_client
    try:
        from backend.services.order_sync import build_working_orders
        await shared.run_in_broker_thread(client.api.update_status)
        trades = await shared.run_in_broker_thread(client.get_order_history)
        return {o.get("symbol") for o in build_working_orders(trades)
                if o.get("symbol")}
    except Exception as e:
        logger.warning(f"panic: 取活躍委託商品失敗（略過撤單集合擴充）: {e}")
        return set()


@router.post("/panic")
async def panic():
    """
    恐慌鈕：一鍵全面停機。步驟（各步獨立 best-effort，回報各自結果）：
      1. trading_enabled=False —— 先停用新單，避免撤/平的同時又有新單進場。
      2. 撤所有智慧單（避免觸價再送單）。
      3. 雙側全撤所有活躍委託（持倉商品 ∪ 有掛單商品）。
      4. 平倉全部持倉。
    """
    result: dict = {"trading_disabled": False, "smart_orders_cancelled": None,
                    "cancelled_orders": 0, "flattened_symbols": [],
                    "errors": []}
    client = shared.shioaji_client
    eng = shared.engine
    rm = getattr(eng, "risk_manager", None) if eng else None
    Action = _action_enum()

    # 1. 立即停用新單
    if rm is not None:
        try:
            rm.config.trading_enabled = False
            result["trading_disabled"] = True
        except Exception as e:
            result["errors"].append(f"disable_trading: {e}")
    else:
        result["errors"].append("risk_manager 不可用，未能停用交易")

    # 2. 撤所有智慧單（best-effort）
    try:
        soe = getattr(eng, "smart_order_engine", None) if eng else None
        if soe is not None and hasattr(soe, "cancel_all"):
            result["smart_orders_cancelled"] = await shared.run_in_broker_thread(
                soe.cancel_all)
    except Exception as e:
        result["errors"].append(f"cancel_smart_orders: {e}")

    # 收集商品：持倉商品 ∪ 有活躍委託商品
    positions = []
    try:
        positions = await shared.run_in_broker_thread(client.list_positions) or []
    except Exception as e:
        result["errors"].append(f"list_positions: {e}")
    pos_symbols = {p.get("symbol") for p in positions if p.get("symbol")}
    work_symbols = await _symbols_with_working_orders()
    all_symbols = {s for s in (pos_symbols | work_symbols) if s}

    # 3. 雙側全撤
    for sym in all_symbols:
        for act in (Action.Buy, Action.Sell):
            try:
                n = await shared.run_in_broker_thread(client.cancel_all, sym, act)
                result["cancelled_orders"] += int(n or 0)
            except Exception as e:
                result["errors"].append(f"cancel_all {sym} {act}: {e}")

    # 4. 平倉全部持倉
    for sym in pos_symbols:
        try:
            ok = await shared.run_in_broker_thread(client.flatten_position, sym)
            if ok:
                result["flattened_symbols"].append(sym)
        except Exception as e:
            result["errors"].append(f"flatten {sym}: {e}")

    logger.critical(
        "[safety] PANIC 觸發：trading_disabled=%s, cancelled=%s, flattened=%s, errors=%s",
        result["trading_disabled"], result["cancelled_orders"],
        result["flattened_symbols"], len(result["errors"]))
    result["status"] = "ok" if not result["errors"] else "partial"
    return result


@router.get("/safety/health")
async def safety_health():
    """
    安全健康列：供前端狀態列快速判讀系統是否處於安全態。
    欄位：熔斷狀態 / trading_enabled / 每日下單計數與上限 / 每日名目與上限 /
          panic_rate / 最近對帳落差 / 連線狀態。
    """
    from core import risk_invariants

    client = shared.shioaji_client
    eng = shared.engine
    rm = getattr(eng, "risk_manager", None) if eng else None

    risk_block = None
    if rm is not None:
        cfg = rm.config
        total = float(getattr(rm, "_daily_realized_pnl", 0.0) or 0.0) + \
            float(getattr(rm, "_daily_unrealized_pnl", 0.0) or 0.0)
        # 「熔斷中」= 交易被停用（日虧損 / 硬上限 / 速率凍結 / 恐慌鈕任一）
        halted = not cfg.trading_enabled
        risk_block = {
            "halted": halted,
            "trading_enabled": cfg.trading_enabled,
            "daily_total_pnl": total,
            "max_daily_loss": cfg.max_daily_loss,
            "daily_order_count": getattr(rm, "_daily_order_count", 0),
            "max_orders_per_day": getattr(rm, "max_orders_per_day", 0),
            "daily_notional": getattr(rm, "_daily_notional", 0.0),
            "max_notional_per_day": getattr(rm, "max_notional_per_day", 0.0),
            "panic_rate": getattr(rm, "panic_rate", 0),
        }

    return {
        "status": "ok",
        "risk": risk_block,
        "invariant_enforce": risk_invariants.INVARIANT_ENFORCE,
        "last_reconciliation": risk_invariants.get_last_reconciliation(),
        "connection": {
            "shioaji_connected": bool(getattr(client, "_is_connected", False)),
            "ws_clients": len(shared.active_connections),
        },
    }
