"""
C1：confirm_order_cancelled 的「未觀測守門」安全測試。

CHASE cancel-replace 靠 confirm_order_cancelled 讀「該委託實際累計成交量」，
再以真正剩量掛新腿（維持不變量：活躍掛單量 + 已成量 ≤ qty）。

風險：若委託在撤單前「從未被我方快照觀測過」（剛送出交易所尚未回報、或它
從未進入 list_trades 快照）就查不到，絕不可用 filled=0 當成「零成交、全部
剩量」放行重掛 —— 舊單其實可能已於交易所端成交，盲送剩量會超額建倉。

守門規則（本測試驗證）：
  - 至少觀測過一次（讀到 found 且取得 status/deal_quantity）後委託才「消失」
    → 回 {"cancelled": True, "filled_qty": 實際已成量}
  - 從未觀測過就查不到 → 逾時回 None，讓引擎保留舊單、下輪再確認，不放行重掛
用既有 fake_shioaji（不修改它）。
"""
import os
import sys
from types import SimpleNamespace

_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

import fake_shioaji  # noqa: E402
fake_shioaji.install()

from core.shioaji_client import ShioajiClient  # noqa: E402


def _make_client():
    c = ShioajiClient()
    c._is_connected = True
    return c


def test_confirm_returns_none_when_order_never_observed():
    """委託首輪即查不到且從未觀測 → 回 None（不放行重掛），而非 cancelled/filled=0。"""
    c = _make_client()
    c.api.trades = []  # 該委託從不出現在 list_trades
    info = c.confirm_order_cancelled(["ORDMISSING"],
                                     timeout_s=0.05, poll_interval_s=0.01)
    assert info is None


def test_confirm_reports_cancelled_with_real_fill_after_observed_then_gone():
    """曾觀測過活躍委託（deal_quantity=1）、之後它從清單消失 →
    回 cancelled=True 且帶回實際已成量 1（不是未觀測的 0）。"""
    c = _make_client()
    trade = SimpleNamespace(
        order=SimpleNamespace(id="ORD1", seqno="1", ordno="ORD1"),
        status=SimpleNamespace(status=SimpleNamespace(name="Submitted"),
                               deal_quantity=1),
    )
    calls = {"n": 0}

    def fake_list_trades():
        calls["n"] += 1
        # 第一輪看得到（觀測到 deal_quantity=1），之後消失
        return [trade] if calls["n"] == 1 else []

    c.api.list_trades = fake_list_trades
    info = c.confirm_order_cancelled(["ORD1"], timeout_s=1.0, poll_interval_s=0.0)
    assert info == {"cancelled": True, "filled_qty": 1}
    assert calls["n"] >= 2  # 確實跨到「消失」那一輪才放行


def test_confirm_terminal_status_still_reports_cancelled():
    """觀測到明確終態（Cancelled）→ 立即回 cancelled=True（回歸保護，
    確認守門沒有把已觀測的正常撤單終態也擋掉）。"""
    c = _make_client()
    trade = SimpleNamespace(
        order=SimpleNamespace(id="ORD9", seqno="9", ordno="ORD9"),
        status=SimpleNamespace(status=SimpleNamespace(name="Cancelled"),
                               deal_quantity=0),
    )
    c.api.trades = [trade]
    info = c.confirm_order_cancelled(["ORD9"], timeout_s=0.2, poll_interval_s=0.01)
    assert info == {"cancelled": True, "filled_qty": 0}
