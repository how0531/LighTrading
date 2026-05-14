"""
trade_stats.compute_stats 測試
"""
import importlib.util
import os
import sys

_HERE = os.path.dirname(__file__)
_PATH = os.path.abspath(os.path.join(_HERE, "..", "backend", "services", "trade_stats.py"))
_spec = importlib.util.spec_from_file_location("trade_stats", _PATH)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["trade_stats"] = _mod
_spec.loader.exec_module(_mod)
compute_stats = _mod.compute_stats


def P(ts, delta, cum, action="Sell"):
    """一個 curve point；symbol/price/qty 不影響統計"""
    return {"ts": ts, "delta": delta, "realized_pnl": cum,
            "symbol": "TXFR1", "price": 17000, "qty": 1, "action": action}


def test_empty_returns_zeros_and_nulls():
    s = compute_stats([])
    assert s["count_total"] == 0
    assert s["win_rate"] is None
    assert s["profit_factor"] is None
    assert s["sharpe_per_trade"] is None
    assert s["max_drawdown"] == 0


def test_opens_only_no_closings():
    # 三筆開倉，沒有任何配對 → delta 都是 0
    s = compute_stats([P(1, 0, 0), P(2, 0, 0), P(3, 0, 0)])
    assert s["count_total"] == 3
    assert s["count_closing"] == 0
    assert s["wins"] == 0 and s["losses"] == 0
    assert s["win_rate"] is None


def test_all_winning_trades():
    s = compute_stats([P(1, 1000, 1000), P(2, 2000, 3000), P(3, 500, 3500)])
    assert s["wins"] == 3 and s["losses"] == 0
    assert s["win_rate"] == 1.0
    assert s["avg_win"] == round((1000 + 2000 + 500) / 3)
    # 全勝沒 loss → profit_factor 是 None（除以 0 的安全分支）
    assert s["profit_factor"] is None
    assert s["max_drawdown"] == 0


def test_mixed_wins_and_losses():
    # delta:    +500   -200   +1000  -300   +400
    # cum:      500    300    1300   1000   1400
    # peak history: 500, 500, 1300, 1300, 1400
    # max drawdown peak=1300 → cum=1000 → dd=300
    s = compute_stats([
        P(1,  500,  500),
        P(2, -200,  300),
        P(3, 1000, 1300),
        P(4, -300, 1000),
        P(5,  400, 1400),
    ])
    assert s["wins"] == 3 and s["losses"] == 2
    assert s["win_rate"] == 0.6
    assert s["avg_win"] == round((500 + 1000 + 400) / 3)
    assert s["avg_loss"] == round((200 + 300) / 2)
    assert s["profit_factor"] == round((500 + 1000 + 400) / (200 + 300), 3)
    assert s["biggest_win"] == 1000
    assert s["biggest_loss"] == 300
    assert s["max_drawdown"] == 300
    assert s["final_realized_pnl"] == 1400


def test_max_drawdown_duration():
    # peak 在 t=1000ms, 谷底在 t=5000ms → duration 4 秒
    s = compute_stats([
        P(1000,  1000, 1000),    # peak
        P(2000,  -100,  900),
        P(3000,  -200,  700),
        P(4000,  -100,  600),
        P(5000,  -100,  500),    # 谷底
        P(6000,   200,  700),
    ])
    assert s["max_drawdown"] == 500
    assert s["max_drawdown_duration_s"] == 4


def test_sharpe_requires_2_or_more_closings():
    # 只有 1 筆 closing → sharpe 不算
    s1 = compute_stats([P(1, 1000, 1000)])
    assert s1["sharpe_per_trade"] is None
    # 兩筆 closing 但相同 delta → stdev=0 → 不算
    s2 = compute_stats([P(1, 500, 500), P(2, 500, 1000)])
    assert s2["sharpe_per_trade"] is None
    # 差異夠大 → 有值
    s3 = compute_stats([P(1, 500, 500), P(2, -200, 300), P(3, 800, 1100)])
    assert s3["sharpe_per_trade"] is not None


def test_expectancy_calculation():
    # 2 wins (avg 750) + 2 losses (avg 250) → win_rate=0.5
    # expectancy = 0.5*750 - 0.5*250 = 250
    s = compute_stats([
        P(1,  500,  500),
        P(2, -200,  300),
        P(3, 1000, 1300),
        P(4, -300, 1000),
    ])
    assert s["expectancy"] == 250


# ── Sprint 27 操作節奏 ───────────────────────────────────────

def test_pace_with_two_trades_returns_interval():
    s = compute_stats([P(1000, 0, 0), P(6000, 0, 0)])
    assert s["mean_interval_s"] == 5.0
    assert s["median_interval_s"] == 5.0
    assert s["shortest_interval_s"] == 5.0
    assert s["peak_fills_per_minute"] == 2  # 兩筆都在 60s 內


def test_pace_picks_shortest_correctly():
    # 間隔：10s, 2s, 30s → shortest=2 （ts 必須 > 0，0 會被過濾）
    s = compute_stats([
        P(1_000,  0, 0),
        P(11_000, 0, 0),
        P(13_000, 0, 0),
        P(43_000, 0, 0),
    ])
    assert s["shortest_interval_s"] == 2.0
    assert s["mean_interval_s"] == round((10 + 2 + 30) / 3, 1)


def test_pace_peak_per_minute_is_max_60s_window():
    # ts in seconds (×1000 = ms): 1, 30, 50, 80, 110
    # window [1, 50]:   3 筆；window [30, 80]: 3 筆；window [50, 110]: 3 筆
    s = compute_stats([P(t * 1000, 0, 0) for t in (1, 30, 50, 80, 110)])
    assert s["peak_fills_per_minute"] == 3


def test_pace_single_trade_returns_nulls():
    s = compute_stats([P(1, 0, 0)])
    assert s["mean_interval_s"] is None
    assert s["shortest_interval_s"] is None
    assert s["peak_fills_per_minute"] == 1


def test_pace_empty_returns_zero_peak():
    s = compute_stats([])
    assert s["peak_fills_per_minute"] == 0
    assert s["mean_interval_s"] is None
