"""
equity_curve.py — 從 trade_journal 的 fills 算「已實現 PnL 累積曲線」

FIFO 配對：每筆 fill 進來時：
  1. 若同方向 (Buy+持有多 / Sell+持有空)：直接 enqueue
  2. 若反方向：從 queue head pop 配對，計算已實現損益累加，
     若 fill 數量大於 head → 繼續 pop 下一個，直到耗盡或反向倉位用完
  3. 剩餘的 fill 數量視為新開倉

每筆 fill 都吐一個 curve 點：`{ts, realized_pnl, symbol, action, qty, price, delta}`
其中 `realized_pnl` 是「至今累積已實現 PnL」（金額，已含 multiplier）。

注意：跨 backend 重啟仍以同一個 SQLite 為主。若使用者中途人工調整 DB
就會偏離真實，但 journal 是 append-only 設計，正常使用不會偏。
"""
from __future__ import annotations
from typing import Callable, Iterable, Optional

from backend.services.contract_specs import get_multiplier as _multiplier_for


def compute_realized_curve(
    fills: Iterable[dict],
    on_unmatched: Optional[Callable[[str, dict, int, int], None]] = None,
) -> list[dict]:
    """
    fills: 必須按 ts 升序；每個 dict 至少有 ts / symbol / action(Buy|Sell) / price / qty。
    回傳每筆 fill 對應的 curve 點，realized_pnl 為「至此筆為止累積實現損益」。

    on_unmatched(symbol, fill, closed_qty, opened_qty)：可選風控告警 hook。
      當一筆成交「平掉部分反向倉後仍有剩量翻向新開」（closed_qty>0 且 opened_qty>0）
      時觸發。這在完整歷史下通常是刻意反手，但也可能是「開倉腳被截斷/遺失」
      → 平倉配不到完整反向倉 → 部分被誤當新開倉、delta 少算。對日虧損熔斷而言，
      寧可告警並保守處理，也不要靜默把平倉當開倉而漏計虧損（讓「損益不明」
      靜默解除熔斷）。呼叫端（refresh_daily_realized）據此發告警並保守餵入。
    """
    open_lots: dict[str, list[tuple[int, float]]] = {}  # symbol -> [(signed_qty, price), ...]
    realized = 0.0
    out: list[dict] = []
    for f in fills:
        sym = (f.get("symbol") or "").upper()
        action = f.get("action") or ""
        price = float(f.get("price") or 0)
        qty = int(f.get("qty") or 0)
        if not sym or qty <= 0 or price <= 0:
            continue
        mult = _multiplier_for(sym)
        sign = 1 if action == "Buy" else -1
        qty_left = qty
        delta = 0.0
        closed_qty = 0

        positions = open_lots.setdefault(sym, [])
        # 配對：head 若與此 fill 反向就 pop
        while qty_left > 0 and positions and positions[0][0] * sign < 0:
            head_qty, head_price = positions[0]
            head_abs = abs(head_qty)
            match = min(qty_left, head_abs)
            if head_qty > 0:
                pnl = (price - head_price) * match * mult         # 多單平倉
            else:
                pnl = (head_price - price) * match * mult         # 空單回補
            delta += pnl
            realized += pnl
            qty_left -= match
            closed_qty += match
            if head_abs == match:
                positions.pop(0)
            else:
                head_sign = 1 if head_qty > 0 else -1
                positions[0] = (head_sign * (head_abs - match), head_price)

        # 配完還有剩 → 新開同向倉位
        if qty_left > 0:
            positions.append((sign * qty_left, price))
            # ★ 平掉部分反向倉又翻向新開 → 可能是開倉腳被截斷/遺失導致平倉配不齊。
            #   通知風控告警 hook（呼叫端保守處理，不讓損益不明靜默解除熔斷）。
            if closed_qty > 0 and on_unmatched is not None:
                try:
                    on_unmatched(sym, f, closed_qty, qty_left)
                except Exception:
                    pass

        out.append({
            "ts": int(f.get("ts") or 0),
            "symbol": sym,
            "action": action,
            "price": price,
            "qty": qty,
            "delta": round(delta),                # 本筆 fill 對 realized PnL 的貢獻
            "realized_pnl": round(realized),      # 累積
        })
    return out
