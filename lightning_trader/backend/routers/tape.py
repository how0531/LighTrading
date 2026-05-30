"""
routers/tape.py — Time & Sales 跑馬燈

  GET /api/tape/{symbol}?limit=100   最近 N 筆成交（新的在後）
"""
from fastapi import APIRouter, HTTPException, Query
from backend import shared

router = APIRouter(prefix="/api/tape", tags=["tape"])


def _tape():
    t = getattr(shared.engine, "tape_recorder", None)
    if t is None:
        raise HTTPException(status_code=503, detail={
            "code": "TAPE_UNAVAILABLE", "user_msg": "TapeRecorder 尚未初始化"
        })
    return t


@router.get("/{symbol}")
async def get_tape(symbol: str, limit: int = Query(default=100, ge=1, le=500)):
    rows = _tape().get(symbol, limit)
    return {"symbol": symbol.upper(), "count": len(rows), "rows": rows}
