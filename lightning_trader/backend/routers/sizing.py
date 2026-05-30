"""
routers/sizing.py — 風險基礎的倉位計算機

POST /api/calc_qty
  {
    "symbol": "TXFR1",        # 用來查 contract.multiplier；股票傳代碼即可
    "risk_amount": 2000,      # 願意冒險的台幣
    "entry_price": 17000,
    "stop_price":  16995
  }

回傳：
  {
    "qty": 2, "actual_risk": 2000, "risk_per_qty": 1000,
    "distance": 5, "multiplier": 200, "warnings": []
  }
"""
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from backend import shared
from core.position_sizer import calc_qty

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["sizing"])


# Shioaji 期貨乘數查不到時的 fallback（與 pnl_broadcaster 同一張表）
_FALLBACK_MULTIPLIERS = {
    "TXF": 200, "MXF": 50, "EXF": 4000, "GTF": 200,
}


def _resolve_multiplier(symbol: str) -> float:
    """優先從 Shioaji contract 取 multiplier，失敗 fallback 到表，再失敗 → 1（股票）。"""
    sym = (symbol or "").strip().upper()
    if not sym:
        return 1.0
    try:
        contract = shared.shioaji_client.get_contract(sym)
        if contract is not None:
            m = getattr(contract, "multiplier", None) or getattr(contract, "unit", None)
            if m:
                return float(m)
    except Exception:
        pass
    for prefix, mult in _FALLBACK_MULTIPLIERS.items():
        if sym.startswith(prefix):
            return float(mult)
    return 1.0


class CalcQtyRequest(BaseModel):
    symbol: str
    risk_amount: float = Field(gt=0, le=10_000_000)
    entry_price: float = Field(gt=0)
    stop_price: float = Field(gt=0)
    max_qty: int = Field(default=100, ge=1, le=1000)


@router.post("/calc_qty")
async def calc_qty_endpoint(req: CalcQtyRequest):
    multiplier = await shared.run_in_qt_thread(_resolve_multiplier, req.symbol)
    res = calc_qty(
        risk_amount=req.risk_amount,
        entry_price=req.entry_price,
        stop_price=req.stop_price,
        multiplier=multiplier,
        max_qty=req.max_qty,
    )
    return {
        "qty":          res.qty,
        "actual_risk":  res.actual_risk,
        "risk_per_qty": res.risk_per_qty,
        "distance":     res.distance,
        "multiplier":   res.multiplier,
        "warnings":     res.warnings,
    }
