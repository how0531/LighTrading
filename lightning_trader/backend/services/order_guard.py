"""
order_guard.py — 智慧單觸發的統一風控閘門 + 日已實現損益餵入

之前智慧單觸發（停損 / 移停 / OCO / Bracket 進場）直接呼叫
client.place_order，完全繞過 RiskManager，即使 trading_enabled=False 也照送。

政策：
  - 「保護性」單（方向與現有淨部位相反、且量不超過淨部位 → 平倉/減倉）
    永遠放行 —— 日虧損熔斷後仍必須能執行停損，否則熔斷反而鎖死出場。
  - 「開倉性」單（加碼 / 反向開倉 / 無部位進場）走完整 pre_order_check；
    WARNING 視為使用者掛單時已確認（skip_warnings），BLOCK 則攔下並廣播。

日已實現損益：
  RiskManager 的 max_daily_loss 需要真實的 realized PnL。這裡在每筆成交後
  以 trade_journal 當日 fills 做 FIFO 配對重算（與 equity_curve 同一套邏輯），
  餵回 RiskManager。
"""
import logging
import time
from datetime import datetime, timedelta

from shioaji.constant import Action

from backend import shared
from backend.services import trade_journal
from backend.services.equity_curve import compute_realized_curve

logger = logging.getLogger(__name__)


def _net_position(symbol: str) -> int:
    """查詢商品目前有號淨部位（Buy 為正）。查不到時回 0。"""
    try:
        positions = shared.shioaji_client.list_positions()
    except Exception as e:
        logger.warning(f"order_guard 查持倉失敗: {e}")
        return 0
    net = 0
    sym = symbol.strip().upper()
    for p in positions or []:
        if (p.get("symbol") or "").upper() != sym:
            continue
        qty = int(p.get("qty", 0) or 0)
        net += qty if p.get("direction") == "Buy" else -qty
    return net


def smart_place_order(symbol: str, price: float, action: str, qty: int):
    """
    智慧單觸發 / Bracket 進場專用下單函數（在 broker thread 上執行）。
    回傳 shioaji trade 物件；被風控攔下或失敗時回 None。
    """
    client = shared.shioaji_client
    rm = getattr(shared.engine, "risk_manager", None) if shared.engine else None

    net = _net_position(symbol)
    delta = qty if action == "Buy" else -qty
    # 保護性：方向與淨部位相反，且量不超過現有部位（平倉/減倉）
    protective = net != 0 and net * delta < 0 and abs(delta) <= abs(net)

    if rm is not None and not protective:
        pos_dir = "Flat" if net == 0 else ("Buy" if net > 0 else "Sell")
        result = rm.pre_order_check(
            symbol=symbol, action=action, qty=qty, price=price,
            is_market_order=(price == 0),
            position_qty=abs(net), position_direction=pos_dir,
            skip_warnings=True,  # 掛智慧單時使用者已確認
        )
        if not result.passed:
            msg = f"智慧單觸發被風控攔下: {action} {symbol} {qty}口 — {result.reason}"
            logger.warning(f"[order_guard] {msg}")
            try:
                shared.engine.event_bus.on_risk_breach.emit("block", msg)
            except Exception:
                pass
            return None

    action_enum = action if isinstance(action, Action) else (
        Action.Buy if str(action).lower() == "buy" else Action.Sell
    )
    return client.place_order(symbol, price, action_enum, qty)


# ─── 日已實現損益餵入 ───────────────────────────────────────

def _today_start_ms() -> int:
    now = datetime.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp() * 1000)


def refresh_daily_realized():
    """
    用 journal 當日 fills 做 FIFO 重算已實現損益，餵給 RiskManager。
    每筆成交回報後由 bridge 呼叫（丟進 broker thread，不佔行情執行緒）。
    """
    rm = getattr(shared.engine, "risk_manager", None) if shared.engine else None
    if rm is None:
        return
    try:
        fills = trade_journal.fetch_fills(from_ts=_today_start_ms(), limit=5000)
        fills.sort(key=lambda f: f.get("ts") or 0)  # fetch_fills 是 DESC，FIFO 需要 ASC
        curve = compute_realized_curve(fills)
        realized = curve[-1]["realized_pnl"] if curve else 0.0
        rm.update_daily_pnl(realized=realized)
    except Exception as e:
        logger.error(f"refresh_daily_realized 失敗: {e}")
