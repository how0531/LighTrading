"""
routers/risk.py — RiskManager 狀態、設定、每日重置

端點：
  GET  /api/risk_status        當前風控狀態（trading_enabled、日損益、計數器）
  GET  /api/risk_config        當前設定
  PUT  /api/risk_config        前端 SettingsModal 同步過來的新設定
  POST /api/risk_reset_daily   手動重置日虧損計數
"""
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from backend import shared

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["risk"])


class RiskConfigPayload(BaseModel):
    max_position_per_symbol: Optional[int]   = Field(default=None, ge=1, le=10000)
    max_position_enabled:    Optional[bool]  = None
    max_daily_loss:          Optional[float] = None
    max_daily_loss_enabled:  Optional[bool]  = None
    price_deviation_pct:     Optional[float] = Field(default=None, ge=0, le=50)
    price_deviation_enabled: Optional[bool]  = None
    max_order_rate:          Optional[int]   = Field(default=None, ge=1, le=100)
    max_order_rate_enabled:  Optional[bool]  = None
    duplicate_window_ms:     Optional[int]   = Field(default=None, ge=0, le=10000)
    duplicate_check_enabled: Optional[bool]  = None
    market_order_confirm:    Optional[bool]  = None
    reverse_confirm:         Optional[bool]  = None
    trading_enabled:         Optional[bool]  = None


def _rm():
    rm = getattr(shared.engine, "risk_manager", None)
    if rm is None:
        raise HTTPException(status_code=503, detail={
            "code": "RISK_UNAVAILABLE", "user_msg": "RiskManager 尚未初始化"
        })
    return rm


@router.get("/risk_status")
async def risk_status():
    rm = _rm()
    cfg = rm.config
    return {
        "trading_enabled": cfg.trading_enabled,
        "daily_realized_pnl":   rm._daily_realized_pnl,
        "daily_unrealized_pnl": rm._daily_unrealized_pnl,
        "max_daily_loss": cfg.max_daily_loss,
        "max_position_per_symbol": cfg.max_position_per_symbol,
    }


@router.get("/risk_config")
async def get_risk_config():
    rm = _rm()
    cfg = rm.config
    return {
        "max_position_per_symbol": cfg.max_position_per_symbol,
        "max_position_enabled":    cfg.max_position_enabled,
        "max_daily_loss":          cfg.max_daily_loss,
        "max_daily_loss_enabled":  cfg.max_daily_loss_enabled,
        "price_deviation_pct":     cfg.price_deviation_pct,
        "price_deviation_enabled": cfg.price_deviation_enabled,
        "max_order_rate":          cfg.max_order_rate,
        "max_order_rate_enabled":  cfg.max_order_rate_enabled,
        "duplicate_window_ms":     cfg.duplicate_window_ms,
        "duplicate_check_enabled": cfg.duplicate_check_enabled,
        "market_order_confirm":    cfg.market_order_confirm,
        "reverse_confirm":         cfg.reverse_confirm,
        "trading_enabled":         cfg.trading_enabled,
    }


@router.put("/risk_config")
async def put_risk_config(payload: RiskConfigPayload):
    rm = _rm()
    updates = payload.model_dump(exclude_none=True)
    if not updates:
        return {"status": "noop"}
    rm.update_config(**updates)
    logger.info(f"RiskConfig 已更新: {list(updates.keys())}")
    return {"status": "success", "applied": updates}


@router.post("/risk_reset_daily")
async def reset_daily():
    rm = _rm()
    rm.reset_daily()
    # 重置後重新啟用交易（如果之前被日虧損鎖住）
    rm.config.trading_enabled = True
    logger.info("RiskManager 日虧損已重置，trading_enabled=True")
    return {"status": "success"}
