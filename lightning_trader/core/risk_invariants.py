"""
risk_invariants.py — 執行期資金安全不變量層（Runtime Safety Net）

把「資金安全不變量」（invariants，任何時刻都必須成立的斷言）寫成可斷言的
謂詞，集中在 check_invariant() 驗證。違反不變量代表系統進入了不該存在的
狀態（超額成交、送出未經檢查的單、對帳落差過大…），是資金安全的最後一道
防線。

★ 核心安全原則：預設 observe-only。
  - 違反時只 logger.critical + event_bus.on_risk_breach.emit("critical", msg)
    告警，「不」自動熔斷。這樣即使不變量誤判也不會擋掉使用者的合法交易。
  - 只有顯式設定環境變數 LIGHTRADE_INVARIANT_ENFORCE=true（強制模式）時，
    違反才額外呼叫 risk_manager 熔斷（trading_enabled=False）。

★ 誠實原則：資料取不到的不變量必須 skip（回 None），不可製造假違反。
  每個 check_* helper 在無法取得可靠資料時回 None（跳過），只有能明確判定
  「成立 / 違反」時才回 True / False。

本模組刻意不 import 任何 backend 模組（core 不依賴 backend）；event_bus 與
risk_manager 由呼叫端（order_guard / safety router）以參數注入。
"""
import json
import logging
import os
import time
from typing import Optional

logger = logging.getLogger(__name__)


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


# ── 全域強制旗標（預設 False = observe-only）──
# 於 import 時讀環境變數；測試可直接覆寫本模組全域 INVARIANT_ENFORCE。
INVARIANT_ENFORCE: bool = _env_flag("LIGHTRADE_INVARIANT_ENFORCE")

# 對帳落差閾值（invariant c）：|computed - broker| 超過此值視為違反。
# 預設極小，但因目前對帳路徑多半取不到券商 realized（一律 skip），不會誤報。
RECON_THRESHOLD: float = _env_float("LIGHTRADE_RECON_THRESHOLD", 1.0)

# 最近一次對帳結果（供 /api/safety/health 顯示；None = 尚無資料）
_last_reconciliation: Optional[dict] = None


def get_last_reconciliation() -> Optional[dict]:
    """回傳最近一次對帳落差紀錄（None = 尚無資料）。供健康列讀取。"""
    return _last_reconciliation


# ──────────────────────────────────────────────────────────────
# 集中驗證入口
# ──────────────────────────────────────────────────────────────

def check_invariant(name: str, ok: bool, context: Optional[dict] = None,
                    *, event_bus=None, risk_manager=None) -> bool:
    """
    斷言一個資金安全不變量。

    Args:
        name: 不變量名稱（log / 告警用）。
        ok:   謂詞結果。True = 成立（無事）；False = 違反。
        context: 診斷用上下文（會進 log 與告警訊息）。
        event_bus: 注入的 EventBus（違反時 emit on_risk_breach "critical"）。
        risk_manager: 注入的 RiskManager（強制模式下違反時熔斷）。

    Returns:
        ok 原值。observe-only 下即使回 False，呼叫端「不」被要求阻擋——
        違反只是告警；是否阻擋交給既有風控（pre_order_check）決定。

    行為：
        ok=True  → 直接回 True。
        ok=False → logger.critical + on_risk_breach.emit("critical", msg)；
                   若 INVARIANT_ENFORCE 且提供 risk_manager → 熔斷。
    """
    if ok:
        return True

    ctx = context or {}
    msg = f"資金安全不變量違反 [{name}] {ctx}"
    logger.critical(f"[risk_invariants] {msg}")

    if event_bus is not None:
        try:
            event_bus.on_risk_breach.emit("critical", msg)
        except Exception:
            logger.exception("[risk_invariants] 發送 on_risk_breach 失敗")

    if INVARIANT_ENFORCE and risk_manager is not None:
        try:
            risk_manager.config.trading_enabled = False
            logger.critical(
                f"[risk_invariants] 強制模式：因不變量 [{name}] 違反已熔斷 "
                f"(trading_enabled=False)")
        except Exception:
            logger.exception("[risk_invariants] 強制熔斷失敗")

    return False


# ──────────────────────────────────────────────────────────────
# 不變量謂詞（純函式，可獨立測試）
# ──────────────────────────────────────────────────────────────

def invariant_order_intent_valid(intended_qty, checked_or_protective: bool) -> bool:
    """
    不變量 (a)：送單前「該單意圖量 ≥ 0 且經過 pre_order_check（或為豁免的
    保護性平倉單）」。

    任何送出的單都必須是「非負量」且「走過風控檢查」——除非它是刻意豁免
    風控的保護性平倉單（reduce-only，日虧損熔斷後仍須能出場）。
    """
    try:
        q = int(intended_qty)
    except (TypeError, ValueError):
        return False
    return q >= 0 and bool(checked_or_protective)


def invariant_no_overfill(ordered_qty, filled_qty, working_qty) -> bool:
    """
    不變量 (b)：某 order 的「活躍掛單量 + 已成量 ≤ 委託量」。

    filled + working > ordered 代表超額成交/超額掛單（券商回報異常、
    cancel-replace 競態導致的重複掛單…），是嚴重的資金安全事件。
    """
    return (int(working_qty) + int(filled_qty)) <= int(ordered_qty)


def invariant_reconciliation_within(computed, broker_reported,
                                    threshold: float) -> bool:
    """
    不變量 (c)：對帳時「(realized+unrealized) 與券商回報偏差在閾值內」。
    """
    return abs(float(computed) - float(broker_reported)) <= float(threshold)


# ──────────────────────────────────────────────────────────────
# 帶資料擷取的高階檢查（在 hook 點呼叫；資料不足即 skip）
# ──────────────────────────────────────────────────────────────

def check_order_intent(intended_qty, checked_or_protective: bool,
                       *, event_bus=None, risk_manager=None,
                       context: Optional[dict] = None) -> bool:
    """不變量 (a) 的送單前 hook。"""
    ok = invariant_order_intent_valid(intended_qty, checked_or_protective)
    return check_invariant(
        "order_intent_valid", ok,
        {**(context or {}), "qty": intended_qty,
         "checked_or_protective": checked_or_protective},
        event_bus=event_bus, risk_manager=risk_manager)


def _extract_overfill_triple(fill: Optional[dict]):
    """
    盡量從成交回報 dict 抽出 (ordered_qty, filled_cum_qty, working_qty)。
    ★ 誠實：任何一項抽不到可靠值 → 回 None（呼叫端 skip，不誤報）。

    成交 callback 沒有單一 schema：先看 fill 上的直接欄位，再回退解析
    fill['raw']（原始 trade_data 的 JSON）裡的 order.quantity / 累計成交量。
    """
    if not isinstance(fill, dict):
        return None

    def _to_int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    ordered = None
    for k in ("order_qty", "ordered_qty", "total_quantity", "order_quantity"):
        if fill.get(k) is not None:
            ordered = _to_int(fill.get(k))
            break
    cum = None
    for k in ("cum_quantity", "cum_qty", "filled_qty", "deal_quantity"):
        if fill.get(k) is not None:
            cum = _to_int(fill.get(k))
            break
    working = None
    for k in ("working_qty", "leaves_qty", "remaining_qty"):
        if fill.get(k) is not None:
            working = _to_int(fill.get(k))
            break

    # 回退：解析 raw（原始 trade_data）
    if (ordered is None or cum is None) and isinstance(fill.get("raw"), str):
        try:
            raw = json.loads(fill["raw"])
        except (ValueError, TypeError):
            raw = None
        if isinstance(raw, dict):
            order = raw.get("order") or {}
            status = raw.get("status") or {}
            if ordered is None:
                ordered = _to_int(
                    order.get("quantity") if isinstance(order, dict) else None)
            if cum is None:
                for src, k in ((raw, "cum_quantity"), (raw, "total_quantity"),
                               (status, "deal_quantity")):
                    if isinstance(src, dict) and src.get(k) is not None:
                        cum = _to_int(src.get(k))
                        break

    if ordered is None or cum is None:
        return None      # 資料不足 → skip
    if working is None:
        working = 0      # 無 working 欄位時保守以 0 計（仍能抓 cum > ordered）
    return ordered, cum, working


def check_fill_no_overfill(fill: Optional[dict], *, event_bus=None,
                           risk_manager=None) -> Optional[bool]:
    """
    不變量 (b) 的成交入帳 hook。
    資料足夠 → 回 True/False（並在違反時告警）；資料不足 → 回 None（skip）。
    """
    triple = _extract_overfill_triple(fill)
    if triple is None:
        return None
    ordered, cum, working = triple
    ok = invariant_no_overfill(ordered, cum, working)
    check_invariant(
        "no_overfill", ok,
        {"symbol": (fill or {}).get("symbol"),
         "order_id": (fill or {}).get("order_id"),
         "ordered": ordered, "filled_cum": cum, "working": working},
        event_bus=event_bus, risk_manager=risk_manager)
    return ok


def check_orders_no_overfill(orders, *, event_bus=None,
                             risk_manager=None) -> Optional[bool]:
    """
    不變量 (b) 的對帳批次版：掃活躍委託快照（build_working_orders 輸出，
    每筆含 qty=委託量、filled_qty=已成量），逐筆檢查 filled ≤ ordered。
    回傳：全部通過 True；有違反 False；無資料 None（skip）。
    """
    if not orders:
        return None
    all_ok = True
    saw_data = False
    for o in orders:
        try:
            ordered = int(o.get("qty"))
            filled = int(o.get("filled_qty", 0) or 0)
        except (TypeError, ValueError, AttributeError):
            continue
        saw_data = True
        # 活躍委託：working = ordered - filled（券商未回超額時恆成立），
        # 這裡實質檢查 filled ≤ ordered（超額成交偵測）。
        working = max(ordered - filled, 0)
        ok = invariant_no_overfill(ordered, filled, working)
        if not ok:
            all_ok = False
            check_invariant(
                "no_overfill", False,
                {"symbol": o.get("symbol"), "order_id": o.get("order_id"),
                 "ordered": ordered, "filled_cum": filled, "working": working},
                event_bus=event_bus, risk_manager=risk_manager)
    if not saw_data:
        return None
    return all_ok


def record_reconciliation(computed, broker_reported, *,
                          threshold: Optional[float] = None,
                          event_bus=None, risk_manager=None) -> Optional[bool]:
    """
    不變量 (c) 的對帳 hook：記錄並檢查對帳落差。
    ★ 誠實：broker_reported 取不到（None）→ 記為「不可得」並 skip（回 None），
      不製造假違反。
    """
    global _last_reconciliation
    thr = RECON_THRESHOLD if threshold is None else threshold
    if broker_reported is None:
        _last_reconciliation = {
            "available": False, "computed": _safe_float(computed),
            "broker_reported": None, "delta": None,
            "threshold": thr, "ts": int(time.time() * 1000),
        }
        return None
    delta = _safe_float(computed) - _safe_float(broker_reported)
    ok = invariant_reconciliation_within(computed, broker_reported, thr)
    _last_reconciliation = {
        "available": True, "computed": _safe_float(computed),
        "broker_reported": _safe_float(broker_reported),
        "delta": delta, "within_threshold": ok,
        "threshold": thr, "ts": int(time.time() * 1000),
    }
    check_invariant("reconciliation_within_threshold", ok,
                    {"computed": computed, "broker_reported": broker_reported,
                     "delta": delta, "threshold": thr},
                    event_bus=event_bus, risk_manager=risk_manager)
    return ok


def _safe_float(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0
