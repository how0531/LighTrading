"""
routers/journal.py — Trade journal endpoints

Sprint 14：把 SQLite 落下的 fills 暴露成 API 讓前端查詢。
所有時戳統一用 unix ms。

  GET /api/journal/fills?from_ts=&to_ts=&symbol=&limit=
  GET /api/journal/stats?from_ts=&to_ts=
"""
import logging
from typing import Optional
from fastapi import APIRouter
from backend.services import trade_journal
from backend.services.equity_curve import compute_realized_curve
from backend.services.trade_stats import compute_stats

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/journal", tags=["journal"])


@router.get("/fills")
async def get_fills(
    from_ts: Optional[int] = None,
    to_ts: Optional[int] = None,
    symbol: Optional[str] = None,
    limit: int = 500,
):
    """歷史成交清單（最近 N 筆，倒序）。"""
    return trade_journal.fetch_fills(from_ts=from_ts, to_ts=to_ts, symbol=symbol, limit=limit)


@router.get("/stats")
async def get_stats(
    from_ts: Optional[int] = None,
    to_ts: Optional[int] = None,
):
    """區間內統計：筆數、買賣口數、首尾時間、top symbols。"""
    return trade_journal.fetch_stats(from_ts=from_ts, to_ts=to_ts)


@router.get("/equity")
async def get_equity_curve(
    from_ts: Optional[int] = None,
    to_ts: Optional[int] = None,
    symbol: Optional[str] = None,
    limit: int = 5000,
):
    """
    Sprint 15：FIFO 配對的累積已實現 PnL 曲線。
    回傳 [{ts, realized_pnl, delta, symbol, action, qty, price}, ...] 升序排列。
    """
    # fetch_fills 倒序、要反轉成升序給 FIFO 算
    fills = trade_journal.fetch_fills(from_ts=from_ts, to_ts=to_ts, symbol=symbol, limit=limit)
    fills_asc = list(reversed(fills))
    return compute_realized_curve(fills_asc)


@router.get("/stats_advanced")
async def get_stats_advanced(
    from_ts: Optional[int] = None,
    to_ts: Optional[int] = None,
    symbol: Optional[str] = None,
    limit: int = 5000,
):
    """
    Sprint 16：交易績效統計（win rate, max drawdown, profit factor, ...）
    從 equity curve 衍生，所以同樣是 FIFO 結算後的數字。
    """
    fills = trade_journal.fetch_fills(from_ts=from_ts, to_ts=to_ts, symbol=symbol, limit=limit)
    fills_asc = list(reversed(fills))
    curve = compute_realized_curve(fills_asc)
    return compute_stats(curve)
