"""
trade_stats.py — 從 equity_curve 衍生交易績效統計 + 操作節奏

Input: equity_curve.compute_realized_curve 吐出的 points list
       （`{ts, symbol, action, price, qty, delta, realized_pnl}`，已 FIFO 配對）

Output: 一份 stats dict 含：
  - count_total            總成交筆數
  - count_closing          產生 realized PnL 的「平倉筆數」（delta != 0）
  - wins / losses          正/負交易筆數
  - win_rate               wins / (wins + losses)；無平倉筆數時為 None
  - avg_win / avg_loss     平均賺與平均賠（loss 為正值）
  - profit_factor          sum_wins / sum_losses；分母 0 時為 None
  - biggest_win / biggest_loss
  - max_drawdown           曲線從歷史峰值 → 谷底的最大跌幅（正值）
  - max_drawdown_duration_s  最大回撤持續秒數
  - sharpe_per_trade       簡化版：avg(delta) / stdev(delta) — non-NaN 才算
  - expectancy             win_rate*avg_win - (1-win_rate)*avg_loss
  - Sprint 27 操作節奏：
    - mean_interval_s      平均兩筆間隔
    - median_interval_s    中位數間隔
    - shortest_interval_s  最快兩單間隔
    - peak_fills_per_minute 60s 滑動視窗內最高下單數
"""
from __future__ import annotations
from typing import Iterable
import statistics


def _compute_pace(pts: list[dict]) -> dict:
    """從 ts (ms) 序列算節奏 metrics。需至少 2 筆才有意義。"""
    ts_list = sorted(int(p.get("ts") or 0) for p in pts if int(p.get("ts") or 0) > 0)
    if len(ts_list) < 2:
        return {
            "mean_interval_s": None,
            "median_interval_s": None,
            "shortest_interval_s": None,
            "peak_fills_per_minute": len(ts_list),
        }
    intervals_ms = [ts_list[i] - ts_list[i - 1] for i in range(1, len(ts_list))]
    intervals_s = [ms / 1000.0 for ms in intervals_ms]
    mean_s = statistics.mean(intervals_s)
    median_s = statistics.median(intervals_s)
    shortest_s = min(intervals_s)

    # peak_fills_per_minute：60s 滑動視窗（兩根 pointer），找最大窗內筆數
    window = 60_000
    left = 0
    peak = 1
    for right in range(len(ts_list)):
        while ts_list[right] - ts_list[left] > window:
            left += 1
        peak = max(peak, right - left + 1)

    return {
        "mean_interval_s": round(mean_s, 1),
        "median_interval_s": round(median_s, 1),
        "shortest_interval_s": round(shortest_s, 2),
        "peak_fills_per_minute": peak,
    }


def compute_stats(curve_points: Iterable[dict]) -> dict:
    """從 equity_curve 點集算統計。"""
    pts = [p for p in curve_points if isinstance(p, dict)]
    if not pts:
        return {
            "count_total": 0, "count_closing": 0,
            "wins": 0, "losses": 0, "win_rate": None,
            "avg_win": 0, "avg_loss": 0, "profit_factor": None,
            "biggest_win": 0, "biggest_loss": 0,
            "max_drawdown": 0, "max_drawdown_duration_s": 0,
            "sharpe_per_trade": None,
            "expectancy": 0,
            "final_realized_pnl": 0,
            "mean_interval_s": None,
            "median_interval_s": None,
            "shortest_interval_s": None,
            "peak_fills_per_minute": 0,
        }

    deltas = [int(p.get("delta") or 0) for p in pts]
    closings = [d for d in deltas if d != 0]
    wins = [d for d in closings if d > 0]
    losses = [-d for d in closings if d < 0]  # 存正值方便比較
    n_closing = len(closings)

    win_rate = (len(wins) / n_closing) if n_closing > 0 else None
    avg_win  = (sum(wins)   / len(wins))   if wins   else 0
    avg_loss = (sum(losses) / len(losses)) if losses else 0
    profit_factor = (sum(wins) / sum(losses)) if losses and sum(losses) > 0 else None
    biggest_win  = max(wins)   if wins   else 0
    biggest_loss = max(losses) if losses else 0   # 正值

    # Max drawdown：從曲線高點到後續低點
    peak = float("-inf")
    peak_ts = 0
    max_dd = 0
    max_dd_dur = 0
    for p in pts:
        ts = int(p.get("ts") or 0)
        cum = int(p.get("realized_pnl") or 0)
        if cum > peak:
            peak = cum
            peak_ts = ts
        dd = peak - cum
        if dd > max_dd:
            max_dd = dd
            max_dd_dur = max(0, (ts - peak_ts) // 1000)

    # Sharpe-like：avg / stdev (per trade)，至少 2 筆才有統計意義
    sharpe = None
    if len(closings) >= 2:
        mean_d = statistics.mean(closings)
        stdev_d = statistics.pstdev(closings)
        if stdev_d > 0:
            sharpe = round(mean_d / stdev_d, 3)

    expectancy = 0
    if win_rate is not None:
        expectancy = round(win_rate * avg_win - (1 - win_rate) * avg_loss)

    pace = _compute_pace(pts)

    return {
        "count_total":   len(pts),
        "count_closing": n_closing,
        "wins":   len(wins),
        "losses": len(losses),
        "win_rate":      round(win_rate, 4) if win_rate is not None else None,
        "avg_win":       round(avg_win),
        "avg_loss":      round(avg_loss),
        "profit_factor": round(profit_factor, 3) if profit_factor is not None else None,
        "biggest_win":   biggest_win,
        "biggest_loss":  biggest_loss,
        "max_drawdown":  max_dd,
        "max_drawdown_duration_s": max_dd_dur,
        "sharpe_per_trade": sharpe,
        "expectancy":    expectancy,
        "final_realized_pnl": int(pts[-1].get("realized_pnl") or 0),
        **pace,
    }
