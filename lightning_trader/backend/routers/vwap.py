"""
routers/vwap.py — VWAP 查詢端點

  GET  /api/vwap/{symbol}     單一商品 VWAP snapshot
  GET  /api/vwap              所有商品 VWAP（dict by symbol）
  POST /api/vwap/reset        手動重置（盤前用；自動重置由 main 的 04:00 task 觸發）
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from backend import shared

router = APIRouter(prefix="/api/vwap", tags=["vwap"])


def _vwap():
    v = getattr(shared.engine, "vwap_calculator", None)
    if v is None:
        raise HTTPException(status_code=503, detail={
            "code": "VWAP_UNAVAILABLE", "user_msg": "VWAPCalculator 尚未初始化"
        })
    return v


@router.get("")
async def get_all():
    snaps = _vwap().get_all()
    return {sym: {"vwap": s.vwap, "total_volume": s.total_volume, "tick_count": s.tick_count}
            for sym, s in snaps.items()}


@router.get("/{symbol}")
async def get_one(symbol: str):
    s = _vwap().get(symbol)
    if s is None:
        return {"symbol": symbol.upper(), "vwap": None, "total_volume": 0, "tick_count": 0}
    return {"symbol": s.symbol, "vwap": s.vwap,
            "total_volume": s.total_volume, "tick_count": s.tick_count}


class ResetReq(BaseModel):
    symbol: Optional[str] = None


@router.post("/reset")
async def reset(req: ResetReq):
    _vwap().reset_session(req.symbol)
    return {"status": "success"}
