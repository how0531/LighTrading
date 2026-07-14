"""
test_safety_net.py — 執行期安全網（WS1）測試

涵蓋：
  1. 不變量層：observe-only 下違反只告警不熔斷；ENFORCE=True 下違反熔斷；
     超額不變量的資料擷取（有資料才判、無資料 skip）。
  2. 每日硬上限：未設 = 無限；設定後達上限 BLOCK；reduce-only 豁免。
  3. 異常速率凍結：超硬閾值自動熔斷 + critical 告警。
  4. 恐慌鈕端點：撤單 + 平倉 + 停用新單。
  5. 安全健康端點：欄位齊全。

★ 自帶模組級 fake 安裝與重置，不依賴其他組正在改的 conftest。
"""
import importlib
import os
import sys
from types import SimpleNamespace

# ── 模組級：把測試目錄加入 path 並安裝 fake shioaji（core/__init__ 需要）──
sys.path.insert(0, os.path.dirname(__file__))
import fake_shioaji  # noqa: E402
fake_shioaji.install()

# ── 重置可能污染判定的環境變數（確保「預設安全」語意）──
for _v in ("LIGHTRADE_INVARIANT_ENFORCE", "LIGHTRADE_MAX_ORDERS_PER_DAY",
           "LIGHTRADE_MAX_NOTIONAL_PER_DAY", "LIGHTRADE_PANIC_RATE",
           "LIGHTRADE_PANIC_RATE_WINDOW_S"):
    os.environ.pop(_v, None)

from core import risk_invariants  # noqa: E402
from core.event_bus import EventBus  # noqa: E402
from core.risk_manager import RiskManager, RiskConfig, CheckLevel  # noqa: E402


# ─────────────────────────── 工具 ───────────────────────────

def _bus_with_capture():
    bus = EventBus()
    captured = []
    bus.on_risk_breach.connect(lambda level, msg: captured.append((level, msg)))
    return bus, captured


def _rm(env=None, bus=None, **cfg):
    """在指定 env 下建 RiskManager（env 讀取發生在 __init__）。"""
    old = {}
    env = env or {}
    for k, v in env.items():
        old[k] = os.environ.get(k)
        os.environ[k] = str(v)
    try:
        # 預設關掉會干擾「硬上限/速率」隔離測試的其他規則
        base = dict(max_order_rate_enabled=False, duplicate_check_enabled=False,
                    market_order_confirm=False, max_position_enabled=False,
                    reverse_confirm=False)
        base.update(cfg)
        return RiskManager(bus or EventBus(), RiskConfig(**base))
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ══════════════════ 1. 不變量層 ══════════════════

def test_invariant_predicates():
    assert risk_invariants.invariant_order_intent_valid(3, True) is True
    assert risk_invariants.invariant_order_intent_valid(-1, True) is False
    assert risk_invariants.invariant_order_intent_valid(3, False) is False
    assert risk_invariants.invariant_no_overfill(5, 3, 2) is True   # 3+2<=5
    assert risk_invariants.invariant_no_overfill(5, 4, 2) is False  # 4+2>5
    assert risk_invariants.invariant_reconciliation_within(100, 100.5, 1.0) is True
    assert risk_invariants.invariant_reconciliation_within(100, 105, 1.0) is False


def test_invariant_observe_only_alerts_but_does_not_halt():
    """預設 observe-only：違反只 critical 告警，不熔斷（不擋合法交易）。"""
    assert risk_invariants.INVARIANT_ENFORCE is False   # 預設安全
    bus, captured = _bus_with_capture()
    rm = RiskManager(bus, RiskConfig())
    assert rm.config.trading_enabled is True

    ok = risk_invariants.check_invariant(
        "unit_test_inv", False, {"why": "test"},
        event_bus=bus, risk_manager=rm)

    assert ok is False
    assert rm.config.trading_enabled is True            # 未熔斷
    assert captured and captured[-1][0] == "critical"   # 有 critical 告警


def test_invariant_enforce_halts_on_violation():
    """強制模式：違反時額外熔斷（trading_enabled=False）。"""
    bus, captured = _bus_with_capture()
    rm = RiskManager(bus, RiskConfig())
    orig = risk_invariants.INVARIANT_ENFORCE
    risk_invariants.INVARIANT_ENFORCE = True
    try:
        risk_invariants.check_invariant(
            "unit_test_inv", False, {"why": "test"},
            event_bus=bus, risk_manager=rm)
    finally:
        risk_invariants.INVARIANT_ENFORCE = orig

    assert rm.config.trading_enabled is False           # 已熔斷
    assert captured and captured[-1][0] == "critical"


def test_invariant_pass_is_noop():
    bus, captured = _bus_with_capture()
    rm = RiskManager(bus, RiskConfig())
    assert risk_invariants.check_invariant("ok_inv", True, event_bus=bus,
                                           risk_manager=rm) is True
    assert captured == []
    assert rm.config.trading_enabled is True


def test_fill_overfill_skips_without_data():
    """誠實：資料取不到 → skip（回 None），不製造假違反。"""
    bus, captured = _bus_with_capture()
    assert risk_invariants.check_fill_no_overfill(
        {"symbol": "2330"}, event_bus=bus) is None
    assert captured == []


def test_fill_overfill_detected_when_data_present():
    bus, captured = _bus_with_capture()
    # order_qty=2 但累計成交 3 → 超額
    r = risk_invariants.check_fill_no_overfill(
        {"symbol": "2330", "order_qty": 2, "cum_quantity": 3},
        event_bus=bus)
    assert r is False
    assert captured and captured[-1][0] == "critical"


def test_orders_batch_overfill():
    bus, captured = _bus_with_capture()
    ok_orders = [{"symbol": "A", "qty": 5, "filled_qty": 3}]
    assert risk_invariants.check_orders_no_overfill(ok_orders, event_bus=bus) is True
    bad_orders = [{"symbol": "B", "qty": 2, "filled_qty": 4}]
    assert risk_invariants.check_orders_no_overfill(bad_orders, event_bus=bus) is False
    assert captured and captured[-1][0] == "critical"
    # 無資料 → skip
    assert risk_invariants.check_orders_no_overfill([]) is None


def test_reconciliation_skips_when_broker_unavailable():
    r = risk_invariants.record_reconciliation(computed=123.0, broker_reported=None)
    assert r is None
    last = risk_invariants.get_last_reconciliation()
    assert last is not None and last["available"] is False


def test_reconciliation_detects_gap():
    bus, captured = _bus_with_capture()
    r = risk_invariants.record_reconciliation(
        computed=1000.0, broker_reported=900.0, threshold=1.0, event_bus=bus)
    assert r is False
    last = risk_invariants.get_last_reconciliation()
    assert last["available"] is True and abs(last["delta"] - 100.0) < 1e-6
    assert captured and captured[-1][0] == "critical"


# ══════════════════ 2. 每日硬上限 ══════════════════

def test_hard_caps_unset_means_unlimited():
    """未設環境變數 = 無限：大量下單皆不因硬上限被擋（不改變現有行為）。"""
    rm = _rm()   # 無 env
    assert rm.max_orders_per_day == 0 and rm.max_notional_per_day == 0.0
    for i in range(50):
        r = rm.pre_order_check("2330", "Buy", qty=1, price=100 + i,
                               skip_warnings=True)
        assert r.passed, (i, r.reason)


def test_max_orders_per_day_blocks_at_limit():
    rm = _rm(env={"LIGHTRADE_MAX_ORDERS_PER_DAY": 3})
    assert rm.max_orders_per_day == 3
    for i in range(3):
        assert rm.pre_order_check("2330", "Buy", qty=1, price=100 + i,
                                  skip_warnings=True).passed
    r = rm.pre_order_check("2330", "Buy", qty=1, price=200, skip_warnings=True)
    assert r.level == CheckLevel.BLOCK
    assert "下單筆數" in r.reason


def test_max_notional_per_day_blocks():
    rm = _rm(env={"LIGHTRADE_MAX_NOTIONAL_PER_DAY": 1000})
    assert rm.max_notional_per_day == 1000.0
    # 第一筆 600 名目 → 過；第二筆使累計 1200 > 1000 → BLOCK
    assert rm.pre_order_check("2330", "Buy", qty=1, price=600,
                              skip_warnings=True).passed
    r = rm.pre_order_check("2330", "Buy", qty=1, price=600, skip_warnings=True)
    assert r.level == CheckLevel.BLOCK
    assert "名目金額" in r.reason


def test_hard_caps_exempt_reduce_only():
    """硬上限豁免 reduce-only：達上限後仍能平倉出場（不把使用者鎖在部位裡）。"""
    rm = _rm(env={"LIGHTRADE_MAX_ORDERS_PER_DAY": 1})
    # 用掉唯一額度（開倉）
    assert rm.pre_order_check("2330", "Buy", qty=1, price=100,
                              skip_warnings=True).passed
    # 對照：再開倉 → BLOCK
    r_open = rm.pre_order_check("2330", "Buy", qty=1, price=101, skip_warnings=True)
    assert r_open.level == CheckLevel.BLOCK and "下單筆數" in r_open.reason
    # reduce-only（持多單 2 口、賣 1 口）→ 豁免，放行
    r_reduce = rm.pre_order_check("2330", "Sell", qty=1, price=101,
                                  position_qty=2, position_direction="Buy",
                                  skip_warnings=True)
    assert r_reduce.passed, r_reduce.reason


def test_hard_cap_counters_reset_on_reset_daily():
    rm = _rm(env={"LIGHTRADE_MAX_ORDERS_PER_DAY": 2})
    rm.pre_order_check("2330", "Buy", qty=1, price=100, skip_warnings=True)
    assert rm._daily_order_count == 1
    rm.reset_daily()
    assert rm._daily_order_count == 0 and rm._daily_notional == 0.0


# ══════════════════ 3. 異常速率凍結 ══════════════════

def test_panic_rate_default_off():
    rm = _rm()
    assert rm.panic_rate == 0
    for i in range(20):
        rm.pre_order_check("2330", "Buy", qty=1, price=100 + i, skip_warnings=True)
    assert rm.config.trading_enabled is True   # 預設關閉，不凍結


def test_panic_rate_freezes_and_alerts():
    bus, captured = _bus_with_capture()
    rm = _rm(env={"LIGHTRADE_PANIC_RATE": 3}, bus=bus)
    assert rm.panic_rate == 3
    for i in range(4):
        rm.pre_order_check("2330", "Buy", qty=1, price=100 + i, skip_warnings=True)
    assert rm.config.trading_enabled is False           # 已自動凍結
    assert any(lvl == "critical" for lvl, _ in captured)


# ══════════════════ 4 & 5. 端點（panic / health）══════════════════

def _make_client(positions):
    calls = {"cancel_all": [], "flatten": []}

    class FakeAPI:
        def update_status(self, *a, **k):
            pass

    class FakeClient:
        def __init__(self):
            self.api = FakeAPI()
            self._is_connected = True

        def list_positions(self):
            return list(positions)

        def get_order_history(self):
            return []

        def cancel_all(self, symbol, action):
            calls["cancel_all"].append((symbol, str(action)))
            return 1

        def flatten_position(self, symbol):
            calls["flatten"].append(symbol)
            return True

    return FakeClient(), calls


def _safety_test_client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.routers import safety
    app = FastAPI()
    app.include_router(safety.router)
    return TestClient(app)


def _install_shared(engine, client):
    from backend import shared
    orig = (shared.engine, shared.shioaji_client)
    shared.engine = engine
    shared.shioaji_client = client
    return shared, orig


def test_panic_cancels_flattens_and_disables():
    from backend import shared  # noqa: F401
    bus = EventBus()
    rm = RiskManager(bus, RiskConfig())          # trading_enabled=True
    client, calls = _make_client([
        {"symbol": "2330", "direction": "Buy", "qty": 2},
    ])
    engine = SimpleNamespace(
        risk_manager=rm, event_bus=bus,
        smart_order_engine=SimpleNamespace(cancel_all=lambda: 0))
    shared_mod, orig = _install_shared(engine, client)
    try:
        tc = _safety_test_client()
        resp = tc.post("/api/panic")
        assert resp.status_code == 200
        data = resp.json()
        assert data["trading_disabled"] is True
        assert rm.config.trading_enabled is False        # 停用新單
        assert "2330" in data["flattened_symbols"]       # 平倉
        assert data["cancelled_orders"] >= 2             # 雙側各撤一筆
        assert "2330" in calls["flatten"]
        # 雙側全撤：Buy + Sell 都被呼叫
        actions = {a for _, a in calls["cancel_all"]}
        assert any("Buy" in a for a in actions) and any("Sell" in a for a in actions)
    finally:
        shared_mod.engine, shared_mod.shioaji_client = orig


def test_safety_health_reports_fields():
    bus = EventBus()
    rm = _rm(env={"LIGHTRADE_MAX_ORDERS_PER_DAY": 5}, bus=bus)
    client, _ = _make_client([])
    engine = SimpleNamespace(risk_manager=rm, event_bus=bus,
                             smart_order_engine=SimpleNamespace(cancel_all=lambda: 0))
    shared_mod, orig = _install_shared(engine, client)
    try:
        tc = _safety_test_client()
        resp = tc.get("/api/safety/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "invariant_enforce" in data
        assert "last_reconciliation" in data       # 可為 None
        risk = data["risk"]
        assert risk is not None
        assert risk["trading_enabled"] is True
        assert risk["halted"] is False
        assert risk["max_orders_per_day"] == 5
        assert "daily_order_count" in risk
        assert "panic_rate" in risk
        assert data["connection"]["shioaji_connected"] is True
        assert "ws_clients" in data["connection"]
    finally:
        shared_mod.engine, shared_mod.shioaji_client = orig
