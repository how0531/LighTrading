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
