"""
order_guard.py — 智慧單觸發的統一風控閘門 + 日已實現損益餵入

之前智慧單觸發（停損 / 移停 / OCO / Bracket 進場）直接呼叫
client.place_order，完全繞過 RiskManager，即使 trading_enabled=False 也照送。

政策：
  - 「保護性」單（方向與現有淨部位相反 → 平倉/減倉）永遠放行 ——
    日虧損熔斷後仍必須能執行停損，否則熔斷反而鎖死出場。
    停損口數若大於淨部位（部分手動出場後的殘留設定），熔斷期間
    自動降為 reduce-only 口數送出，不會整張被擋。
  - 「開倉性」單（加碼 / 反向開倉 / 無部位進場）走完整 pre_order_check；
    WARNING 視為使用者掛單時已確認（skip_warnings）、重複檢查跳過
    （兩張同參數智慧單同 tick 觸發是合法情境），BLOCK 則攔下並廣播。

日已實現損益：
  RiskManager 的 max_daily_loss 需要真實的 realized PnL。作法：對 journal
  的**完整歷史** fills 做完整 FIFO 重建 open_lots（避免跨午夜/隔日倉、以及
  久遠開倉今日平倉的斷頭配對產生幽靈損益/漏計虧損），再取「風控日邊界
  （每日 04:00，與 reset_daily 對齊）或最近一次手動 reset」之後的增量餵回
  RiskManager。

  ★ A3：先前用固定 30 天回看窗切 FIFO —— >30 天前開倉的腳被排除，
    今日平倉配不到反向倉 → 被當新開倉 delta=0 → 真實已實現虧損漏計 →
    日虧損熔斷被繞過。現改以完整歷史重建（fetch_fills_for_fifo，無 5000 截斷），
    並在偵測到「平倉配不到完整開倉腳」時發風控告警 + 保守處理。
    （完整持久化 open_lots 快照為後續工作，見 refresh_daily_realized 註解。）
"""
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Optional

from shioaji.constant import Action

from backend import shared
from backend.services import trade_journal
from backend.services import audit_log
from backend.services.equity_curve import compute_realized_curve
from core import risk_invariants

logger = logging.getLogger(__name__)


def _inv_deps():
    """取注入不變量層的 event_bus / risk_manager（缺則 None，observe-only）。"""
    eng = shared.engine
    event_bus = getattr(eng, "event_bus", None) if eng else None
    rm = getattr(eng, "risk_manager", None) if eng else None
    return event_bus, rm

# 觸發路徑允許沿用 pnl_broadcaster 持倉快取的最大年齡（秒）——
# 避免每次停損觸發都多一輪阻塞的 list_positions
_POS_CACHE_MAX_AGE_S = 2.0


def _net_position(symbol: str) -> Optional[int]:
    """
    查詢商品目前有號淨部位（Buy 為正；聚合用 risk_manager 的唯一定義，
    避免三處複製的正負號預設分歧）。
    優先用 pnl_broadcaster 的新鮮快取；查詢失敗回 None（未知）。
    """
    from core.risk_manager import net_position_of

    # 1. 新鮮快取（每次 tick 都在刷新，1s TTL）
    try:
        from backend.services import pnl_broadcaster as pb
        if pb._pos_cache and (time.monotonic() - pb._pos_cache_time) < _POS_CACHE_MAX_AGE_S:
            return net_position_of(pb._pos_cache, symbol)
    except Exception:
        pass

    # 2. 直接向券商查
    try:
        return net_position_of(shared.shioaji_client.list_positions(), symbol)
    except Exception as e:
        logger.warning(f"order_guard 查持倉失敗: {e}")
        return None


# 哨兵單一定義在 core（引擎的契約），backend 直接 import ——
# 之前兩邊各自定義字串常數、只靠字面相等耦合，分歧時 bracket 會把
# 被攔下的進場當成功、掛出沒有母單的幽靈 OCO
from core.smart_order_engine import RISK_BLOCKED, RATE_LIMITED  # noqa: E402


def smart_place_order(symbol: str, price: float, action: str, qty: int):
    """
    智慧單觸發 / Bracket 進場專用下單函數（在 order executor 上執行）。

    回傳：
      - shioaji trade 物件：成功
      - RISK_BLOCKED（str 哨兵）：被風控攔下（引擎不 re-arm）
      - None：下單失敗（引擎會 re-arm 重試）
    """
    client = shared.shioaji_client
    rm = getattr(shared.engine, "risk_manager", None) if shared.engine else None

    net = _net_position(symbol)
    delta = qty if action == "Buy" else -qty
    send_qty = qty

    if net is not None and net != 0 and net * delta < 0:
        # 方向與淨部位相反 → 含有平倉成分
        if abs(delta) <= abs(net):
            protective = True                     # 純平倉/減倉
        elif rm is not None and not rm.config.trading_enabled:
            # 熔斷中且口數超過淨部位（例如手動先出了一部分）：
            # 降為 reduce-only 口數放行，不讓超額的反向開倉部分卡死整張停損
            protective = True
            send_qty = abs(net)
            msg = (f"熔斷期間停損口數 {qty} 超過淨部位 {abs(net)}，"
                   f"自動降為平倉口數 {send_qty} 送出")
            logger.warning(f"[order_guard] {msg}")
            try:
                shared.engine.event_bus.on_risk_breach.emit("warning", msg)
            except Exception:
                pass
        else:
            protective = False                    # 反向開倉，正常走檢查
    else:
        protective = False

    if rm is not None and not protective:
        abs_net = abs(net) if net is not None else 0
        pos_dir = "Flat" if not net else ("Buy" if net > 0 else "Sell")
        result = rm.pre_order_check(
            symbol=symbol, action=action, qty=send_qty, price=price,
            is_market_order=(price == 0),
            position_qty=abs_net, position_direction=pos_dir,
            skip_warnings=True,   # 掛智慧單時使用者已確認
            skip_duplicate=True,  # 兩張同參數智慧單同 tick 觸發是合法的
        )
        if not result.passed:
            msg = f"智慧單觸發被風控攔下: {action} {symbol} {send_qty}口 — {result.reason}"
            logger.warning(f"[order_guard] {msg}")
            try:
                shared.engine.event_bus.on_risk_breach.emit("block", msg)
            except Exception:
                pass
            # #8：暫態封鎖（頻率限制）回 RATE_LIMITED（CHASE 本輪放棄、下輪重試），
            # 真正的風控封鎖才回 RISK_BLOCKED（終態）
            audit_log.record(audit_log.EVENT_RISK_BLOCK, symbol=symbol,
                             action=str(action), qty=qty, price=price,
                             meta={"reason": msg, "source": "smart"})
            return RATE_LIMITED if getattr(result, "transient", False) else RISK_BLOCKED

    # 不變量 (a)：送單前「意圖量 ≥ 0 且經過 pre_order_check（或為豁免的
    # 保護性平倉單）」。protective 走豁免路徑、rm 存在則已通過檢查才到這裡。
    event_bus, inv_rm = _inv_deps()
    risk_invariants.check_order_intent(
        send_qty, checked_or_protective=(protective or rm is not None),
        event_bus=event_bus, risk_manager=inv_rm,
        context={"symbol": symbol, "action": str(action), "protective": protective})

    action_enum = action if isinstance(action, Action) else (
        Action.Buy if str(action).lower() == "buy" else Action.Sell
    )
    audit_log.record(audit_log.EVENT_SENT, symbol=symbol, action=str(action),
                     qty=send_qty, price=price,
                     meta={"protective": protective, "source": "smart"})
    return client.place_order(symbol, price, action_enum, send_qty)


# ─── 日已實現損益餵入 ───────────────────────────────────────


def _risk_day_start_ms() -> int:
    """風控日邊界：每日 04:00（與 main.py 的 _daily_risk_reset 對齊）。"""
    now = datetime.now()
    start = now.replace(hour=4, minute=0, second=0, microsecond=0)
    if now < start:
        start -= timedelta(days=1)
    return int(start.timestamp() * 1000)


# 已實現重算的合流排程：成交爆量時每筆 fill 都全量重算會把佇列塞爆，
# 用 pending 旗標 + 短暫聚合窗把一波 fills 合併成一次重算
_refresh_lock = threading.Lock()
_refresh_queued = False


def schedule_refresh_daily_realized() -> None:
    """排程一次已實現損益重算（丟到 sync executor，波段內自動合流）。"""
    global _refresh_queued
    with _refresh_lock:
        if _refresh_queued:
            return
        _refresh_queued = True
    try:
        shared.submit_sync_task(_run_refresh_coalesced)
    except Exception:
        with _refresh_lock:
            _refresh_queued = False


def _run_refresh_coalesced() -> None:
    global _refresh_queued
    time.sleep(0.2)   # 聚合同一波成交（sync executor 專用執行緒，睡得起）
    with _refresh_lock:
        _refresh_queued = False
    refresh_daily_realized()


def fill_side_effects(fill: Optional[dict]) -> None:
    """
    成交後的共用副作用（callback 路徑與 order_sync 對帳路徑共用，
    之前兩處 copy-paste 各自維護）：
      1. 發射 on_fill（Bracket 母單成交偵測）
      2. 作廢 PnL 持倉快取（下一 tick 用新部位重算）
      3. 排程已實現損益重算（風控熔斷資料源；合流防抖）
    """
    try:
        if fill and shared.engine:
            shared.engine.event_bus.on_fill.emit(fill)
    except Exception:
        pass
    # 委託生命週期審計：成交事件（callback 與對帳兩路徑共用此處，故全部成交都入軌）
    if fill:
        audit_log.record(
            audit_log.EVENT_FILL,
            order_id=fill.get("order_id") or fill.get("ordno"),
            symbol=fill.get("symbol") or fill.get("code"),
            action=fill.get("action"),
            qty=fill.get("qty") or fill.get("quantity"),
            price=fill.get("price"),
            meta={"id": fill.get("id")})
    # 不變量 (b)：成交入帳時「活躍掛單量 + 已成量 ≤ 委託量」（超額偵測）。
    # 資料取不到 → check_fill_no_overfill 內部 skip（回 None），不誤報。
    try:
        event_bus, inv_rm = _inv_deps()
        risk_invariants.check_fill_no_overfill(
            fill, event_bus=event_bus, risk_manager=inv_rm)
    except Exception:
        logger.debug("fill 超額不變量檢查略過", exc_info=True)
    try:
        from backend.services import pnl_broadcaster as pb
        pb.on_fill_event()
    except Exception:
        pass
    schedule_refresh_daily_realized()


def refresh_daily_realized():
    """
    重算「本風控日」的已實現損益，餵給 RiskManager。
    請透過 schedule_refresh_daily_realized() 排程（合流 + 不佔下單佇列）。

    作法：對 journal **完整歷史** fills 做完整 FIFO 重建 open_lots（跨午夜夜盤、
    久遠開倉今日平倉都能正確配對），取風控日邊界（或最近一次手動 reset）後的
    累積增量。

    ★ A3 安全核心修：
      1. open_lots 基準改以完整歷史重建（fetch_fills_for_fifo，拿掉 30 天下限）。
      2. 抓齊路徑不套 fetch_fills 的 5000 截斷（久遠開倉腳不可被截掉）。
      3. compute_realized_curve 偵測到「平倉配不到完整開倉腳」→ 不靜默 delta=0，
         發風控告警（logger.critical + on_risk_breach）並保守處理：不讓偏樂觀、
         可能低估虧損的 realized 去解除熔斷（取與現值的較小者）。

    後續（本次不做）：完整持久化 open_lots 快照（每日收盤 snapshot + 增量重播），
      免去每次重算都全量掃歷史；屆時 fetch_fills_for_fifo 可只補快照後的增量。
    """
    rm = getattr(shared.engine, "risk_manager", None) if shared.engine else None
    if rm is None:
        return
    try:
        boundary = max(_risk_day_start_ms(), int(getattr(rm, "last_reset_ms", 0) or 0))
        # 完整歷史重建（升序、無 5000 截斷）——久遠開倉腳不可被排除
        fills = trade_journal.fetch_fills_for_fifo(from_ts=None)

        unmatched = {"hit": False, "detail": ""}

        def _on_unmatched(symbol, fill, closed_qty, opened_qty):
            unmatched["hit"] = True
            unmatched["detail"] = (
                f"{symbol} @ {fill.get('price')} 平倉配不到完整開倉腳"
                f"（已平 {closed_qty}、反向新開 {opened_qty}）")

        curve = compute_realized_curve(fills, on_unmatched=_on_unmatched)
        final = curve[-1]["realized_pnl"] if curve else 0.0
        baseline = 0.0
        for pt in curve:
            if (pt.get("ts") or 0) < boundary:
                baseline = pt["realized_pnl"]
            else:
                break
        realized = final - baseline

        if unmatched["hit"]:
            # 損益不明 → 保守：不可讓（可能低估虧損、偏樂觀的）realized 解除熔斷。
            prev = float(getattr(rm, "_daily_realized_pnl", 0.0) or 0.0)
            safe = min(realized, prev)
            msg = (f"已實現損益重算偵測到配不到開倉腳的平倉，日損益可能被低估："
                   f"{unmatched['detail']}；保守採用 {safe:,.0f}（不放寬熔斷）。"
                   f"疑 journal 缺開倉腳，請人工核對。")
            logger.critical(f"[order_guard] {msg}")
            try:
                shared.engine.event_bus.on_risk_breach.emit("warning", msg)
            except Exception:
                pass
            rm.update_daily_pnl(realized=safe)
        else:
            rm.update_daily_pnl(realized=realized)

        # 不變量 (c)：對帳時「(realized+unrealized) 與券商回報偏差在閾值內」。
        # ★ 誠實：此路徑目前取不到券商權威 realized（broker_reported=None）→
        #   record_reconciliation 內部 skip（僅登錄「不可得」供健康列顯示），
        #   不製造假違反。日後接上券商 realized 即可傳入實值啟用比對。
        try:
            event_bus = getattr(shared.engine, "event_bus", None) if shared.engine else None
            computed = (float(getattr(rm, "_daily_realized_pnl", 0.0) or 0.0)
                        + float(getattr(rm, "_daily_unrealized_pnl", 0.0) or 0.0))
            risk_invariants.record_reconciliation(
                computed=computed, broker_reported=None,
                event_bus=event_bus, risk_manager=rm)
        except Exception:
            logger.debug("對帳不變量登錄略過", exc_info=True)
    except Exception as e:
        logger.error(f"refresh_daily_realized 失敗: {e}")
