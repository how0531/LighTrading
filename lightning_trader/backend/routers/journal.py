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
