"""
routers/reports.py — 當日交易彙整 (Sprint 10 R9)

提供：
  GET /api/daily_report?account_id=...&date=YYYY-MM-DD
    - 把當日（或指定日）的成交 + 委託歸納為一份報告
    - 計算 total realized PnL（粗估：成交對沖以最簡單的 FIFO 假設）
    - 按商品分組統計 fill 次數、平均成交價、淨方向
    - 不替代真實的會計結算，但給日內交易者快速回看用

注意：因為 Shioaji client 的 list_trades 只回當日資料，date 參數目前僅做 echo。
未來要 historical 需另外存盤。
"""
import logging
from datetime import datetime
from collections import defaultdict
from typing import Optional
from fastapi import APIRouter
from shioaji.constant import Action
from backend import shared

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["reports"])


@router.get("/daily_report")
async def daily_report(account_id: Optional[str] = None):
    """彙整當日成交回報。回傳結構：
        {
          date, generated_at,
          summary: {trades_count, fills_count, realized_pnl_estimate,
                    buy_lots, sell_lots, top_symbol},
          by_symbol: [ {symbol, fills, buy_lots, sell_lots, avg_buy, avg_sell,
                        net_lots, est_pnl}, ... ]
        }
    """
    try:
        if not getattr(shared.shioaji_client, "_is_connected", False):
            return {
                "date": datetime.now().date().isoformat(),
                "generated_at": datetime.now().isoformat(),
                "error": "尚未登入 Shioaji",
                "summary": None,
                "by_symbol": [],
            }
        # 重用 get_order_history 拉到的格式（已含 status / filled 等）
        try:
            await shared.run_in_broker_thread(shared.shioaji_client.api.update_status)
        except Exception:
            pass
        trades = await shared.run_in_broker_thread(shared.shioaji_client.get_order_history)

        # 按 symbol 累積
        agg: dict[str, dict] = defaultdict(lambda: {
            "fills": 0,
            "buy_lots": 0,
            "sell_lots": 0,
            "buy_value": 0.0,    # sum(price * qty) for averaging
            "sell_value": 0.0,
        })
        total_buy_lots = 0
        total_sell_lots = 0
        trades_count = 0
        fills_count = 0

        for t in trades:
            if account_id and t.order.account.account_id != account_id:
                continue
            raw_symbol = getattr(t.contract, 'symbol', '') or getattr(t.contract, 'code', '')
            if not raw_symbol:
                continue
            trades_count += 1
            deals = getattr(t.status, 'deals', []) or []
            for d in deals:
                price = float(getattr(d, 'price', 0) or 0)
                qty = int(getattr(d, 'quantity', 0) or 0)
                if qty <= 0 or price <= 0:
                    continue
                fills_count += 1
                bucket = agg[raw_symbol]
                bucket["fills"] += 1
                if t.order.action == Action.Buy:
                    bucket["buy_lots"] += qty
                    bucket["buy_value"] += price * qty
                    total_buy_lots += qty
                else:
                    bucket["sell_lots"] += qty
                    bucket["sell_value"] += price * qty
                    total_sell_lots += qty

        # 計算每商品的平均價、淨方向與「粗估 PnL」
        by_symbol = []
        realized_estimate = 0.0
        for sym, b in agg.items():
            avg_buy  = (b["buy_value"]  / b["buy_lots"])  if b["buy_lots"]  > 0 else 0.0
            avg_sell = (b["sell_value"] / b["sell_lots"]) if b["sell_lots"] > 0 else 0.0
            matched = min(b["buy_lots"], b["sell_lots"])
            # 簡化估算：matched 口的 (avg_sell - avg_buy) * 乘數
            multiplier = _multiplier_for(sym)
            est_pnl = round((avg_sell - avg_buy) * matched * multiplier) if matched > 0 else 0
            realized_estimate += est_pnl
            by_symbol.append({
                "symbol": sym,
                "fills": b["fills"],
                "buy_lots": b["buy_lots"],
                "sell_lots": b["sell_lots"],
                "net_lots": b["buy_lots"] - b["sell_lots"],
                "avg_buy": round(avg_buy, 2),
                "avg_sell": round(avg_sell, 2),
                "est_pnl": est_pnl,
            })
        # 按絕對值貢獻排序
        by_symbol.sort(key=lambda x: abs(x["est_pnl"]), reverse=True)
        top_symbol = by_symbol[0]["symbol"] if by_symbol else None

        return {
            "date": datetime.now().date().isoformat(),
            "generated_at": datetime.now().isoformat(),
            "summary": {
                "trades_count": trades_count,
                "fills_count": fills_count,
                "realized_pnl_estimate": round(realized_estimate),
                "buy_lots": total_buy_lots,
                "sell_lots": total_sell_lots,
                "top_symbol": top_symbol,
            },
            "by_symbol": by_symbol,
        }
    except Exception as e:
        logger.error(f"daily_report 失敗: {e}", exc_info=True)
        return {
            "date": datetime.now().date().isoformat(),
            "generated_at": datetime.now().isoformat(),
            "error": str(e),
            "summary": None,
            "by_symbol": [],
        }


# 乘數表唯一來源（contract_specs 無其他依賴，不會循環引用）
from backend.services.contract_specs import get_multiplier as _multiplier_for  # noqa: E402
