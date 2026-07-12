"""
Pytest 共用設定 — 把 lightning_trader/ 加到 sys.path，
讓所有測試都能直接 `from core ...` / `from backend ...`。

另外提供**統一的整合測試重置基建**：多個整合測試模組共用同一份可變的
backend 單例（shared.shioaji_client、engine.risk_manager、fake shioaji 的
下單/持倉紀錄、order_sync 的 in-memory watermark、journal 的 SQLite fills
表、rate_limit buckets…）。過去每個測試檔各自複製一大段 reset，導致：
  - 跨模組污染（flaky bracket、pnl_broadcaster 把 shared.shioaji_client
    換成 MagicMock 沒還原）；
  - reset 邏輯散落、容易漏項、順序相依。

本檔集中成單一 `reset_backend_state()`，並以 autouse fixture 於每個測試前
自動套用。設計原則：**只在 backend 已被載入（fake 已安裝、shared 有
shioaji_client）時才動手**，純單元測試（test_equity_curve 等不碰 backend 的）
呼叫就是 no-op，不受影響、不報錯。新整合測試檔因此**不必自己重寫 reset**。
"""
import sys
import os
import unittest.mock as _mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest


# ─── shared.shioaji_client 還原用的「正典」參考 ─────────────────
# pnl_broadcaster 一類測試會把 shared.shioaji_client 暫時換成 MagicMock。
# 若它忘了還原（或有例外跳過還原），字母序在後、依賴真 fake client 的整合
# 測試（讀 shared.shioaji_client.api）就會壞。我們在第一次看到「真正的
# fake client」時記住它，之後任何一次 reset 發現當前 client 變成 mock，
# 就還原回這個正典參考 —— 防 pnl_broadcaster 型污染的最後防線。
_CANONICAL_CLIENT = None


def _mod(name):
    """只取已載入的模組；未載入回 None（避免此處 import 反而觸發載入）。"""
    return sys.modules.get(name)


def _drain_backend_executors(shared):
    """抽乾 shared 的三個單 worker executor：submit 哨兵並等它完成。

    FIFO 保證前一測試在背景執行緒上 dispatch 的下單/撤單/重算全部落地後，
    呼叫端才會 clear 假紀錄，避免「遲到的寫入」污染下一測試（flaky bracket
    多看到一筆的根因）。"""
    for attr in ("broker_executor", "order_executor", "sync_executor"):
        ex = getattr(shared, attr, None)
        if ex is None:
            continue
        try:
            ex.submit(lambda: None).result(timeout=5)
        except Exception:
            pass


def reset_backend_state():
    """統一重置整合測試共用的 backend 可變狀態。

    僅在 backend 已載入（fake 已安裝、shared.shioaji_client 已設定）時作用；
    否則直接 no-op，讓純單元測試不受影響。各整合測試檔的 `_reset_state`
    可直接沿用本函式，消除重複的 reset 段落。
    """
    global _CANONICAL_CLIENT

    shared = _mod("backend.shared")
    if shared is None or getattr(shared, "shioaji_client", None) is None:
        return  # backend 尚未載入 → 純單元測試，no-op

    # ── 0. 還原 shared.shioaji_client（防 pnl_broadcaster 型污染） ──
    cur = shared.shioaji_client
    if not isinstance(cur, _mock.NonCallableMock):
        # 當前是真正的 fake client → 記為正典
        _CANONICAL_CLIENT = cur
    elif _CANONICAL_CLIENT is not None:
        # 當前被換成 mock 且沒還原 → 還原成原本的 fake client
        shared.shioaji_client = _CANONICAL_CLIENT

    sj = shared.shioaji_client
    api = getattr(sj, "api", None)

    # ── 1. 登入旗標 + active accounts ──
    try:
        sj._is_connected = True
        if api is not None and getattr(api, "_accounts", None):
            sj.active_stock_account = api._accounts[0]
            sj.active_futopt_account = api._accounts[1]
    except Exception:
        pass

    # ── 2. 智慧單引擎：cancel_all + 抽乾三個 executor ──
    eng = getattr(shared, "engine", None)
    if eng is not None:
        soe = getattr(eng, "smart_order_engine", None)
        if soe is not None:
            try:
                soe.cancel_all()
            except Exception:
                pass
    # 先抽乾背景 executor，再清假下單紀錄 —— 順序關鍵。
    _drain_backend_executors(shared)

    # ── 3. fake shioaji 的下單/持倉紀錄 + 競速旗標 ──
    if api is not None:
        for attr, default in (
            ("positions", []),
            ("trades", []),
        ):
            try:
                setattr(api, attr, list(default))
            except Exception:
                pass
        for attr in ("placed_orders", "cancelled_orders", "_pending_cancels"):
            seq = getattr(api, attr, None)
            if seq is not None:
                try:
                    seq.clear()
                except Exception:
                    pass
        # fake 的可選競速行為一律回預設（同步撤單），避免污染其他測試。
        for attr, default in (
            ("async_cancel", False),
            ("flush_cancels_on_status", False),
            ("cancel_race_hook", None),
        ):
            if hasattr(api, attr):
                try:
                    setattr(api, attr, default)
                except Exception:
                    pass

    # ── 4. RiskManager：reset_daily / update_config / 清 positions & prices ──
    if eng is not None:
        rm = getattr(eng, "risk_manager", None)
        if rm is not None:
            try:
                rm.reset_daily()
                rm.update_config(max_position_per_symbol=10, max_daily_loss=-50000.0)
                rm._current_positions.clear()
                rm._current_prices.clear()
            except Exception:
                pass

    # ── 5. rate_limit buckets ──
    rl = _mod("backend.rate_limit")
    if rl is not None and hasattr(rl, "_buckets"):
        try:
            rl._buckets.clear()
        except Exception:
            pass

    # ── 6. order_sync 的模組級 in-memory watermark ──
    # _seen_fill_ids 跨測試累積 → 同 id 的成交在後續測試被誤判「已處理」，
    # new_fills 少算，並遮蔽 insert_fill 對 journal DB 重複入帳的回歸。
    # _last_fingerprint 殘留 → WorkingOrdersSnapshot 的 changed 判定失準。
    osync = _mod("backend.services.order_sync")
    if osync is not None:
        if hasattr(osync, "_seen_fill_ids"):
            try:
                osync._seen_fill_ids.clear()
            except Exception:
                pass
        if hasattr(osync, "_last_fingerprint"):
            osync._last_fingerprint = ""

    # ── 7. journal 全 session 共用同一個 SQLite 檔：每測試清空 fills 表 ──
    # 否則前一測試的成交會漏進下一測試的 FIFO 已實現損益重算，金額斷言
    # 變成順序相依。
    tj = _mod("backend.services.trade_journal")
    if tj is not None:
        try:
            with tj._DB_LOCK:
                tj._connect().execute("DELETE FROM fills")
        except Exception:
            pass


@pytest.fixture(autouse=True)
def _auto_reset_backend_state():
    """autouse：每個測試前自動套用統一重置。

    對純單元測試而言 reset_backend_state() 是 no-op（backend 未載入），
    故此 fixture 全域啟用也不會干擾非整合測試。新整合測試檔因此不必自己
    重寫任何 reset 段落，就能得到與既有整合測試等價的乾淨隔離。
    """
    reset_backend_state()
    yield
