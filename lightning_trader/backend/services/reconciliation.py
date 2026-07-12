"""
reconciliation.py — 啟動對帳協議（WS3，保守安全版）

問題（單一真相來源）：部位 / 委託 / 智慧單狀態同時活在三處——
  1. 券商（權威；list_positions / list_trades）
  2. 我方 SQLite（smart_order_store 的智慧單、trade_journal 的成交）
  3. 前端（畫面快取）

backend 崩潰重啟後，我方 SQLite 可能過時。目前開機是「盲信 SQLite re-arm」：
smart_order_engine 重啟時把 store 內仍 active 的智慧單直接掛回，不與券商校準。
若券商端狀態已變（掛單被外部撤 / 已成 / 持倉不同），我方會帶著過時狀態繼續跑。

本模組在「登入成功且已補訂持倉商品後」執行一次**啟動對帳**：
  - 向券商拉 positions / working orders / trades 快照
  - 與我方狀態（smart_order_engine 的 active 智慧單、trade_journal 近期成交）比對
  - 偵測落差 → **告警**（logger.critical + event_bus.on_risk_breach + audit_log.record）
  - **殭屍智慧單**（我方 active、券商查無對應活躍委託）→ 呼叫
    smart_order_engine 既有的 `sync_broker_orders()`（re-attach / 標終態），不另造輪子

**範圍界線（誠實遵守）**：本次只做「不依賴真 SDK 細節」的安全部分——
  比對 + 告警 + 殭屍智慧單交回既有引擎處理。
  **不做**積極的已實現損益 / journal 改寫（依賴真 SDK 的 Deal 欄位語意，
  待 docs/SDK_GAP_TABLE.md 填完才設計）。詳見 docs/RECONCILIATION.md。

**安全預設（比照 WS1）**：偵測到「無法安全判定」的落差時，預設**只告警不停**。
  設 `LIGHTRADE_RECON_HALT_ON_DIVERGENCE=true` 才會把 trading_enabled 設 False
  要求人工確認（fail-safe halt）。預設 False = 不改變交易行為，只留痕告警。

全程 **best-effort**：任何一步例外都被吞掉、只記 log，**絕不可擋 backend 啟動**。
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from backend import shared
from backend.services import audit_log, order_sync, trade_journal

logger = logging.getLogger(__name__)


def _halt_on_divergence() -> bool:
    """LIGHTRADE_RECON_HALT_ON_DIVERGENCE 是否開啟（預設 False = 只告警不停）。"""
    return os.environ.get(
        "LIGHTRADE_RECON_HALT_ON_DIVERGENCE", "").strip().lower() in ("1", "true", "yes", "on")


def _alert(level: str, message: str) -> None:
    """統一告警管道：logger.critical + event_bus.on_risk_breach（best-effort）。

    level: "warning" | "block"（與 order_guard / on_risk_breach 語意一致）。
    """
    logger.critical("[Reconcile] %s", message)
    try:
        eng = getattr(shared, "engine", None)
        if eng is not None and getattr(eng, "event_bus", None) is not None:
            eng.event_bus.on_risk_breach.emit(level, message)
    except Exception as e:
        logger.debug(f"[Reconcile] on_risk_breach emit 失敗: {e}")


def _audit(event_type: str, **kwargs) -> None:
    """把對帳事件寫進 audit_log（best-effort；失敗不影響對帳流程）。"""
    try:
        audit_log.record(event_type, **kwargs)
    except Exception as e:
        logger.debug(f"[Reconcile] audit 失敗 ({event_type}): {e}")


def _pull_broker_state(client) -> dict:
    """在 sync executor 上拉一份券商快照（阻塞 I/O，不佔用下單佇列）。

    回傳 dict：
      positions        : list[dict] | None（None = 查詢失敗，區分於「真無倉」）
      positions_error  : str | None
      trades           : list（list_trades 原始物件；失敗回 []）
      snapshot_complete: bool（任一帳號 update_status 失敗 → False，缺席不可信）
    """
    out = {
        "positions": None,
        "positions_error": None,
        "trades": [],
        "snapshot_complete": True,
    }

    # ── 持倉（strict：能區分查詢失敗 vs 真無倉；失敗 raise → 記為 error 不臆測） ──
    try:
        out["positions"] = client.list_positions_strict()
    except Exception as e:
        out["positions_error"] = str(e)
        logger.warning(f"[Reconcile] 券商持倉查詢失敗（保守：略過持倉比對）: {e}")

    # ── 委託 / 成交快照（per-account update_status + list_trades） ──
    #   任一帳號 update_status 失敗 → 快照不完整，list_trades 可能只涵蓋部分帳號，
    #   缺席不可信 → 標記給對帳路徑，避免據不完整快照誤判殭屍。
    complete = True
    try:
        api = getattr(client, "api", None)
        if api is not None:
            for acc in api.list_accounts():
                try:
                    api.update_status(acc)
                except Exception:
                    complete = False
            out["trades"] = api.list_trades() or []
    except Exception as e:
        complete = False
        logger.warning(f"[Reconcile] 券商委託/成交快照失敗: {e}")
    out["snapshot_complete"] = complete
    return out


def _local_net_by_symbol() -> dict:
    """從 trade_journal 近期成交推出「我方帳上」各商品淨口數（有號：Buy +、Sell −）。

    這是**唯讀比對**，不改 journal。淨口數推導本質依賴 Deal 欄位語意（待
    SDK_GAP_TABLE 驗證），因此僅用於「偵測落差 → 告警」，不用於任何自動修正。
    """
    net: dict = {}
    try:
        # 大上限撈近期成交（不設 from_ts：盡量涵蓋當前持倉的建倉成交）。
        fills = trade_journal.fetch_fills(limit=50_000)
    except Exception as e:
        logger.warning(f"[Reconcile] 讀 journal 成交失敗（略過持倉數量比對）: {e}")
        return net
    for f in fills or []:
        try:
            sym = str(f.get("symbol") or "").upper()
            if not sym:
                continue
            qty = int(f.get("qty") or 0)
            signed = qty if str(f.get("action")) == "Buy" else -qty
            net[sym] = net.get(sym, 0) + signed
        except (TypeError, ValueError):
            continue
    return net


def _reconcile_positions(positions, report: dict) -> None:
    """比對券商持倉 vs 我方 journal 推導的淨口數。落差 → 告警 + audit。

    保守分類（誠實遵守範圍界線——只偵測、不自動修正）：
      - no_local_record：券商有倉，我方 journal 完全對不上該商品 → 最強落差
      - qty_mismatch   ：商品有紀錄但淨口數對不上 → 落差（精確校正待 SDK 落差表）
    """
    divergences: list = []
    report["positions"] = {"broker_count": len(positions or []), "divergences": divergences}
    if not positions:
        return

    local_net = _local_net_by_symbol()
    known_symbols = set(local_net.keys())
    # 我方 active 智慧單涉及的商品也算「有紀錄」（避免把待成交保護單的商品誤報）
    try:
        eng = getattr(shared, "engine", None)
        soe = getattr(eng, "smart_order_engine", None) if eng else None
        if soe is not None:
            for o in soe.get_active_orders():
                s = str(o.get("symbol") or "").upper()
                if s:
                    known_symbols.add(s)
    except Exception:
        pass

    for p in positions:
        try:
            sym = str(p.get("symbol") or "").upper()
            qty = int(p.get("qty") or 0)
            if not sym or qty == 0:
                continue
            broker_signed = qty if str(p.get("direction")) == "Buy" else -qty
            our_signed = int(local_net.get(sym, 0))
            if broker_signed == our_signed:
                continue  # 一致
            reason = "no_local_record" if sym not in known_symbols else "qty_mismatch"
            div = {
                "symbol": sym,
                "broker_net": broker_signed,
                "local_net": our_signed,
                "reason": reason,
            }
            divergences.append(div)
            _alert("block",
                   f"啟動對帳：持倉落差 {sym} 券商={broker_signed:+d} 我方帳上={our_signed:+d} "
                   f"（{reason}）——請人工確認，自動修正待 SDK 落差表")
            _audit("recon_position_divergence", symbol=sym, qty=qty,
                   meta={"broker_net": broker_signed, "local_net": our_signed, "reason": reason})
        except Exception as e:
            logger.debug(f"[Reconcile] 略過異常持倉項: {e}")


def _reconcile_smart_orders(trades, snapshot_complete: bool, report: dict) -> None:
    """殭屍智慧單偵測 + 交回既有引擎處理。

    - 我方「有券商掛單編號」的 active CHASE（broker_order_ids 非空、CHASING）：
        其編號在券商活躍委託快照中查無 → **殭屍候選**（報告 + 告警 + audit）。
        （快照不完整時不判殭屍——缺席不可信，避免誤殺。）
    - 呼叫 smart_order_engine 既有的 `sync_broker_orders()`：re-attach 對得上的、
      連續數輪對不上的標終態。用既有能力（用呼叫、不改 engine）。
    """
    smart_report = {"active": 0, "broker_linked": 0, "zombies": [], "matched": []}
    report["smart_orders"] = smart_report

    eng = getattr(shared, "engine", None)
    soe = getattr(eng, "smart_order_engine", None) if eng else None
    if soe is None:
        return

    # 券商端「活躍」委託的所有候選編號（id/seqno/ordno）
    try:
        broker_index = order_sync.build_broker_order_index(trades)
    except Exception as e:
        logger.warning(f"[Reconcile] 建券商委託索引失敗: {e}")
        broker_index = []
    active_broker_ids: set = set()
    for bo in broker_index:
        if str(bo.get("status") or "") in order_sync.ACTIVE_STATUSES:
            for i in bo.get("ids") or ():
                active_broker_ids.add(str(i))

    try:
        active_orders = soe.get_active_orders()
    except Exception as e:
        logger.warning(f"[Reconcile] 讀 active 智慧單失敗: {e}")
        active_orders = []
    smart_report["active"] = len(active_orders)

    for o in active_orders:
        try:
            if str(o.get("order_type")) != "CHASE":
                continue  # 只有 CHASE（與 Bracket 進場）會在券商端留活躍掛單；
                          # MIT/OCO/Trailing 是本地條件單，券商無對應掛單 ≠ 殭屍
            ids = [x for x in str(o.get("broker_order_ids") or "").split(",") if x]
            if not ids:
                continue  # 無掛單編號（暫態清空待重掛）→ 非殭屍
            smart_report["broker_linked"] += 1
            if active_broker_ids & set(ids):
                smart_report["matched"].append(o.get("id"))
                continue
            # 券商活躍委託查無此編號
            if not snapshot_complete:
                # 快照不完整、缺席不可信 → 不判殭屍（保守）
                continue
            smart_report["zombies"].append(o.get("id"))
            _alert("block",
                   f"啟動對帳：偵測殭屍智慧單 {o.get('id')}（{o.get('symbol')} CHASE，"
                   f"券商查無對應活躍委託 {ids}）——交由引擎 sync_broker_orders 處理")
            _audit("recon_zombie_smart_order", order_id=o.get("id"),
                   symbol=o.get("symbol"), action=o.get("action"),
                   qty=o.get("qty"),
                   meta={"broker_order_ids": ids, "chase_status": o.get("chase_status")})
        except Exception as e:
            logger.debug(f"[Reconcile] 略過異常智慧單項: {e}")

    # ── 交回既有引擎：re-attach 對得上的 / 標終態對不上的（用呼叫，不改 engine） ──
    try:
        if hasattr(soe, "sync_broker_orders"):
            soe.sync_broker_orders(broker_index, snapshot_complete=snapshot_complete)
    except Exception as e:
        logger.warning(f"[Reconcile] 呼叫 sync_broker_orders 失敗: {e}")


def _maybe_halt(report: dict) -> None:
    """依 LIGHTRADE_RECON_HALT_ON_DIVERGENCE 決定是否 fail-safe 停用交易。

    預設 False（比照 WS1 安全預設）= 只告警不停。True 時把 trading_enabled 設
    False 要求人工確認（不影響 reduce-only 出場——由 RiskManager 既有邏輯放行）。
    """
    divergence_count = len(report.get("positions", {}).get("divergences", [])) \
        + len(report.get("smart_orders", {}).get("zombies", []))
    report["divergence_count"] = divergence_count
    report["halted"] = False
    if divergence_count == 0:
        return
    if not _halt_on_divergence():
        logger.warning(
            "[Reconcile] 偵測到 %d 項落差；LIGHTRADE_RECON_HALT_ON_DIVERGENCE 未開啟 → "
            "只告警不停用交易（安全預設）", divergence_count)
        return
    # HALT：停用交易，要求人工確認
    try:
        eng = getattr(shared, "engine", None)
        rm = getattr(eng, "risk_manager", None) if eng else None
        if rm is not None and getattr(rm, "config", None) is not None:
            rm.config.trading_enabled = False
            report["halted"] = True
            _alert("block",
                   f"啟動對帳：偵測到 {divergence_count} 項落差，"
                   f"LIGHTRADE_RECON_HALT_ON_DIVERGENCE 已開啟 → 已停用交易（trading_enabled=False），"
                   f"請人工確認後再啟用")
            _audit("recon_halt", meta={"divergence_count": divergence_count})
    except Exception as e:
        logger.error(f"[Reconcile] 停用交易失敗: {e}")


async def reconcile_on_startup() -> dict:
    """啟動對帳協議入口（main.py lifespan 於登入成功後 await 一次）。

    全程 best-effort：任何例外都被吞掉、只記 log，**絕不可擋 backend 啟動**。
    回傳一份對帳報告 dict（供測試 / 稽核；正式路徑不依賴回傳值）。
    """
    report: dict = {"ran": False, "skipped": None}
    try:
        client = getattr(shared, "shioaji_client", None)
        if client is None or not getattr(client, "_is_connected", False):
            report["skipped"] = "not_connected"
            logger.info("[Reconcile] 未登入券商 → 跳過啟動對帳")
            return report

        logger.info("[Reconcile] 啟動對帳開始…")
        _audit("recon_start")

        # 券商快照在 sync executor 上拉（阻塞 I/O 不佔用下單佇列 / 不卡 event loop）
        state = await shared.run_in_sync_thread(_pull_broker_state, client)
        report["ran"] = True
        report["snapshot_complete"] = state["snapshot_complete"]
        report["positions_error"] = state["positions_error"]

        # 1. 持倉比對（查詢失敗則保守略過，不臆測）
        if state["positions_error"] is None:
            _reconcile_positions(state["positions"], report)
        else:
            report["positions"] = {"error": state["positions_error"], "divergences": []}
            _alert("warning",
                   f"啟動對帳：券商持倉查詢失敗，本次略過持倉比對（{state['positions_error']}）")

        # 2. 委託 / 智慧單比對（殭屍偵測 + 交回既有引擎處理）
        _reconcile_smart_orders(state["trades"], state["snapshot_complete"], report)

        # 3. 依落差與 HALT 旗標決定是否 fail-safe 停用交易（預設只告警不停）
        _maybe_halt(report)

        divergence_count = report.get("divergence_count", 0)
        zombie_count = len(report.get("smart_orders", {}).get("zombies", []))
        _audit("recon_summary", meta={
            "snapshot_complete": state["snapshot_complete"],
            "broker_positions": report.get("positions", {}).get("broker_count", 0),
            "active_smart_orders": report.get("smart_orders", {}).get("active", 0),
            "zombies": zombie_count,
            "divergence_count": divergence_count,
            "halted": report.get("halted", False),
        })
        logger.info(
            "[Reconcile] 啟動對帳完成：落差 %d、殭屍智慧單 %d、snapshot_complete=%s、halted=%s",
            divergence_count, zombie_count, state["snapshot_complete"], report.get("halted", False))
    except Exception as e:
        # best-effort：對帳任何環節例外都不可擋啟動
        report["error"] = str(e)
        logger.error(f"[Reconcile] 啟動對帳發生例外（已忽略，不擋啟動）: {e}", exc_info=True)
    return report
