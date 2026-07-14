"""
已實現回看窗測試（A3）——固定 30 天回看窗會把久遠開倉腳切掉，導致今日平倉
配不到反向倉、被當新開倉 delta=0、真實已實現虧損漏計 → 熔斷被繞過。

覆蓋：
  1. compute_realized_curve：久遠開倉 + 今日平倉，已實現虧損被正確計入（非 0）。
  2. compute_realized_curve：平倉配不到完整開倉腳（翻向）→ 觸發 on_unmatched 告警。
  3. trade_journal.fetch_fills_for_fifo：升序、不套 5000 截斷（久遠開倉腳不被截掉）。
  4. order_guard.refresh_daily_realized：以完整歷史重建、把今日平倉虧損餵入 rm；
     偵測到配不到開倉腳時發 on_risk_breach 告警且保守處理（不放寬熔斷）。
"""
import importlib
import importlib.util
import os
import sys
import types
from pathlib import Path

_HERE = os.path.dirname(__file__)
_LIGHTNING = os.path.abspath(os.path.join(_HERE, ".."))

# ── 直接從檔案載 equity_curve（繞過 backend/__init__ 的重量依賴）──
_EC_PATH = os.path.join(_LIGHTNING, "backend", "services", "equity_curve.py")
_spec = importlib.util.spec_from_file_location("equity_curve_a3", _EC_PATH)
_ec = importlib.util.module_from_spec(_spec)
sys.modules["equity_curve_a3"] = _ec
_spec.loader.exec_module(_ec)
compute_realized_curve = _ec.compute_realized_curve

_DAY_MS = 86_400_000


def F(ts, action, price, qty, symbol="TXFR1"):
    return {"ts": ts, "symbol": symbol, "action": action, "price": price, "qty": qty}


# ── 1. 久遠開倉 + 今日平倉：虧損被正確計入（非 delta=0）──
def test_old_open_today_close_loss_counted():
    old_ts = 1_600_000_000_000            # 很久以前開倉
    today_ts = old_ts + 400 * _DAY_MS     # 400 天後平倉（遠超 30 天窗）
    out = compute_realized_curve([
        F(old_ts, "Buy", 17000, 1),
        F(today_ts, "Sell", 16900, 1),    # 平多虧損：(16900-17000)*1*200 = -20000
    ])
    assert out[0]["delta"] == 0           # 開倉當下 0
    assert out[1]["delta"] == -20000      # ★ 平倉虧損被計入，不是靜默 0
    assert out[1]["realized_pnl"] == -20000


# ── 2. 平倉配不到完整開倉腳（翻向）→ on_unmatched 告警 ──
def test_unmatched_close_triggers_alert():
    alerts = []
    old_ts = 1_600_000_000_000
    today_ts = old_ts + 400 * _DAY_MS
    out = compute_realized_curve(
        [
            F(old_ts, "Buy", 17000, 1),     # 只看得到 1 口開倉腳
            F(today_ts, "Sell", 16900, 3),  # 卻要平 3 口 → 平 1 + 翻空 2
        ],
        on_unmatched=lambda sym, fill, closed, opened: alerts.append(
            (sym, closed, opened)),
    )
    # 平掉的 1 口虧損有被計入（非 0）
    assert out[1]["delta"] == -20000
    # 配不到完整開倉腳 → 告警觸發，closed=1 opened=2
    assert alerts == [("TXFR1", 1, 2)]


def test_matched_close_does_not_alert():
    """完整配對的平倉不應誤報告警。"""
    alerts = []
    compute_realized_curve(
        [F(1, "Buy", 17000, 2), F(2, "Sell", 17050, 2)],
        on_unmatched=lambda *a: alerts.append(a),
    )
    assert alerts == []


# ── 3. fetch_fills_for_fifo：升序、不套 5000 截斷 ──
def _fresh_journal(tmp_db: Path):
    os.environ["LIGHTRADE_JOURNAL_DB"] = str(tmp_db)
    sys.modules.pop("backend.services.trade_journal", None)
    return importlib.import_module("backend.services.trade_journal")


def test_fifo_fetch_not_truncated_at_5000(tmp_path):
    tj = _fresh_journal(tmp_path / "j.db")
    base = 1_600_000_000_000
    rows = [{"ts": base + i * 1000, "symbol": "TXFR1", "action": "Buy",
             "price": 17000, "qty": 1, "order_id": f"O{i}"} for i in range(5001)]
    res = tj.import_fills(rows)
    assert res["accepted"] == 5001

    # 一般 fetch_fills 被 5000 截斷
    assert len(tj.fetch_fills(limit=10_000)) == 5000
    # FIFO 專用抓齊、升序、含最久遠那筆
    fifo = tj.fetch_fills_for_fifo(from_ts=None)
    assert len(fifo) == 5001
    assert fifo[0]["ts"] == base                     # 最久遠開倉腳沒被截掉
    assert fifo[0]["ts"] <= fifo[-1]["ts"]           # 升序
    assert all(fifo[i]["ts"] <= fifo[i + 1]["ts"] for i in range(len(fifo) - 1))


# ── 4. order_guard.refresh_daily_realized 端到端（stub 掉 shioaji / core）──
def _load_order_guard():
    # stub shioaji.constant
    sh = types.ModuleType("shioaji")
    sc = types.ModuleType("shioaji.constant")

    class _Action:
        Buy = "Buy"
        Sell = "Sell"

    sc.Action = _Action
    sys.modules.setdefault("shioaji", sh)
    sys.modules.setdefault("shioaji.constant", sc)
    # stub core（避免 core/__init__ 拉 shioaji_client）
    core = types.ModuleType("core"); core.__path__ = []
    soe = types.ModuleType("core.smart_order_engine")
    soe.RISK_BLOCKED = "RISK_BLOCKED"; soe.RATE_LIMITED = "RATE_LIMITED"
    rmmod = types.ModuleType("core.risk_manager")
    rmmod.net_position_of = lambda positions, symbol: 0
    sys.modules.setdefault("core", core)
    sys.modules.setdefault("core.smart_order_engine", soe)
    sys.modules.setdefault("core.risk_manager", rmmod)
    sys.modules.pop("backend.services.order_guard", None)
    return importlib.import_module("backend.services.order_guard")


class _FakeRM:
    def __init__(self):
        self.last_reset_ms = 0
        self._daily_realized_pnl = 0.0
        self.fed = []

    def update_daily_pnl(self, realized=None, unrealized=None):
        if realized is not None:
            self._daily_realized_pnl = float(realized)
            self.fed.append(float(realized))


class _Signal:
    def __init__(self):
        self.emitted = []

    def emit(self, *a):
        self.emitted.append(a)


def _install_engine(g, rm):
    from backend import shared
    eng = types.SimpleNamespace(
        risk_manager=rm,
        event_bus=types.SimpleNamespace(on_risk_breach=_Signal()),
    )
    shared.engine = eng
    return eng


def test_refresh_feeds_old_open_today_close_loss(tmp_path, monkeypatch):
    g = _load_order_guard()
    rm = _FakeRM()
    eng = _install_engine(g, rm)

    boundary = g._risk_day_start_ms()
    old_ts = boundary - 90 * _DAY_MS      # 90 天前開倉（>30 天窗）
    today_ts = boundary + 3_600_000       # 本風控日內平倉
    fills = [
        {"ts": old_ts, "symbol": "TXFR1", "action": "Buy", "price": 17000, "qty": 1},
        {"ts": today_ts, "symbol": "TXFR1", "action": "Sell", "price": 16900, "qty": 1},
    ]
    monkeypatch.setattr(g.trade_journal, "fetch_fills_for_fifo",
                        lambda from_ts=None: list(fills))

    g.refresh_daily_realized()

    # 本風控日已實現 = 平倉虧損 -20000（開倉在 boundary 前 → baseline 已含開倉，
    # 增量只算今日平倉），且不是被漏計成 0
    assert rm.fed[-1] == -20000
    assert eng.event_bus.on_risk_breach.emitted == []   # 完整配對，無告警


def test_refresh_unmatched_alerts_and_conservative(tmp_path, monkeypatch):
    g = _load_order_guard()
    rm = _FakeRM()
    rm._daily_realized_pnl = -50000       # 先前已知的較差損益
    eng = _install_engine(g, rm)

    boundary = g._risk_day_start_ms()
    old_ts = boundary - 90 * _DAY_MS
    today_ts = boundary + 3_600_000
    # 只看得到 1 口開倉，卻平 3 口 → 翻向 → 配不到完整開倉腳
    fills = [
        {"ts": old_ts, "symbol": "TXFR1", "action": "Buy", "price": 17000, "qty": 1},
        {"ts": today_ts, "symbol": "TXFR1", "action": "Sell", "price": 16900, "qty": 3},
    ]
    monkeypatch.setattr(g.trade_journal, "fetch_fills_for_fifo",
                        lambda from_ts=None: list(fills))

    g.refresh_daily_realized()

    # 發了風控告警（warning）
    levels = [a[0] for a in eng.event_bus.on_risk_breach.emitted]
    assert "warning" in levels
    # 保守：不可讓偏樂觀的 realized(-20000) 解除較差的既有損益(-50000)
    assert rm.fed[-1] == -50000
