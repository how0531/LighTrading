"""
routers/health.py — Liveness / Readiness 端點

不要求登入也能訪問，讓前端能快速判斷：
  - backend 起來了嗎？(http 200 = yes)
  - shioaji 連線正常嗎？
  - 有幾個 WS client 連著？
"""
import time
from fastapi import APIRouter
from backend import shared

router = APIRouter(prefix="/api", tags=["health"])
_STARTED_AT = time.monotonic()


@router.get("/health")
async def health():
    client = shared.shioaji_client
    shioaji_up = bool(getattr(client, "_is_connected", False))
    last_msg = getattr(client, "last_message_time", 0)
    return {
        "status": "ok",
        "backend_up": True,
        "shioaji_connected": shioaji_up,
        "ws_clients": len(shared.active_connections),
        "uptime_s": round(time.monotonic() - _STARTED_AT, 1),
        "last_message_age_s": round(time.time() - last_msg, 1) if last_msg else None,
        "is_simulation": getattr(client, "is_simulation", None),
    }


@router.get("/metrics")
async def metrics():
    """
    Sprint 10 R8：Diagnostic snapshot — 供前端「系統診斷」按鈕呼叫，
    讓使用者能自助回報問題（截圖 JSON 給 dev 就夠 reproduce）。
    與 /health 區別：metrics 多了 RiskManager 設定值、追蹤的商品數、
    pnl_broadcaster 快取狀態等實際運行細節。
    """
    client = shared.shioaji_client
    eng = shared.engine

    latest_prices = getattr(client, "_latest_prices", {}) or {}
    sym_resolver = getattr(client, "symbol_resolver", None)
    known_symbols = sym_resolver.all_known() if sym_resolver else []
    current_contract = getattr(client, "current_contract", None)
    current_symbol = getattr(current_contract, "symbol", None) if current_contract else None

    risk_mgr = getattr(eng, "risk_manager", None) if eng else None
    risk_payload = None
    if risk_mgr is not None:
        cfg = risk_mgr.config
        risk_payload = {
            "trading_enabled": cfg.trading_enabled,
            "daily_realized_pnl": risk_mgr._daily_realized_pnl,
            "daily_unrealized_pnl": risk_mgr._daily_unrealized_pnl,
            "max_daily_loss": cfg.max_daily_loss,
            "max_position_per_symbol": cfg.max_position_per_symbol,
        }

    # 從 pnl_broadcaster 拿目前 cache snapshot（lazy import 避免 circular）
    pos_cache_size = 0
    try:
        from backend.services import pnl_broadcaster as pb
        pos_cache_size = len(pb._pos_cache)
    except Exception:
        pass

    return {
        "version": "0.1.0",
        "uptime_s": round(time.monotonic() - _STARTED_AT, 1),
        "shioaji": {
            "connected": bool(getattr(client, "_is_connected", False)),
            "is_simulation": getattr(client, "is_simulation", None),
            "current_subscribed_symbol": current_symbol,
            "tracked_symbols": known_symbols,
            "latest_prices_count": len(latest_prices),
        },
        "ws": {
            "clients": len(shared.active_connections),
        },
        "risk": risk_payload,
        "pnl_broadcaster": {
            "cached_positions": pos_cache_size,
        },
        # Sprint 19：下單→成交端到端延遲（ring buffer 最近 200 筆 P50/P95/Max）
        "latency": _latency_payload(),
    }


def _latency_payload() -> dict:
    try:
        from backend.services import latency_tracker
        return latency_tracker.get_metrics()
    except Exception:
        return {"count": 0, "p50_ms": None, "p95_ms": None, "max_ms": None}
