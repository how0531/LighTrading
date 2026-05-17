"""
routers/journal.py — Trade journal endpoints

Sprint 14：把 SQLite 落下的 fills 暴露成 API 讓前端查詢。
所有時戳統一用 unix ms。

  GET /api/journal/fills?from_ts=&to_ts=&symbol=&limit=
  GET /api/journal/stats?from_ts=&to_ts=
"""
import csv
import io
import logging
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel
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


class FillMeta(BaseModel):
    tag: Optional[str] = None
    notes: Optional[str] = None


@router.post("/fill/{fill_id}/meta")
async def update_fill_meta(fill_id: str, body: FillMeta):
    """
    Sprint 32：替某筆成交標記策略 tag / 紀律檢討 notes。
    tag/notes 任一為 None = 不動該欄；空字串 = 清空。
    """
    ok = trade_journal.update_fill_meta(fill_id, tag=body.tag, notes=body.notes)
    if not ok:
        raise HTTPException(
            status_code=404,
            detail={"code": "FILL_NOT_FOUND", "user_msg": "找不到該筆成交，無法標記"},
        )
    return {"status": "success"}


@router.post("/import")
async def import_csv(file: UploadFile = File(...)):
    """
    Sprint 24：CSV import 既有成交資料。

    必要欄位：symbol, action, price, qty
    時間欄位 (擇一)：ts (unix ms)  或  time (ISO 字串如 '2024-05-13T14:30:00')
    可選：order_id, id

    範例 CSV header:
        time,symbol,action,price,qty,order_id
        2024-05-13T09:30:01,TXFR1,Buy,17000,1,X1

    INSERT OR IGNORE 確保重跑同檔不重複。
    """
    if not file:
        raise HTTPException(status_code=400, detail={"code": "NO_FILE", "user_msg": "未上傳檔案"})
    try:
        body = await file.read()
        text = body.decode("utf-8-sig")   # 處理 Excel 匯出的 BOM
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "DECODE_FAIL", "user_msg": f"檔案解碼失敗：{e}"})

    rows: list[dict] = []
    reader = csv.DictReader(io.StringIO(text))
    for line_num, raw_row in enumerate(reader, start=2):  # header 是 line 1
        # 統一欄位名（lower-case，去空白）
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in raw_row.items()}
        # 解析時間：優先 ts，否則 time 字串轉 epoch ms
        ts_ms = 0
        if r.get("ts"):
            try:
                ts_ms = int(float(r["ts"]))
                if ts_ms < 10 ** 12:   # 看起來是秒不是毫秒
                    ts_ms *= 1000
            except ValueError:
                pass
        elif r.get("time"):
            try:
                ts_ms = int(datetime.fromisoformat(r["time"]).timestamp() * 1000)
            except ValueError:
                pass
        rows.append({
            "ts": ts_ms,
            "symbol": r.get("symbol", ""),
            "action": r.get("action", ""),
            "price": r.get("price", 0),
            "qty": r.get("qty", 0),
            "order_id": r.get("order_id", ""),
            "id": r.get("id", ""),
        })

    result = trade_journal.import_fills(rows)
    return {
        "status": "success",
        "total_rows": len(rows),
        "accepted": result["accepted"],
        "skipped": result["skipped"],
        "errors": result["errors"],
    }
