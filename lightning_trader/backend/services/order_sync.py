"""
order_sync.py — 委託對帳迴圈（外部管道下單的即時同步）

問題：Shioaji 的 order callback 只推播「本 session 下的單」。
從其他管道（券商 App、另一個 API session）下的單不會有任何推播，
必須主動 update_status() + list_trades() 才拿得到 —— 之前只靠前端
每 5 秒輪詢 + 本地下單後刷新，外部委託要等輪詢才出現、
外部「成交」更是完全進不了 journal（已實現損益 / 風控熔斷都會漏算）。

解法（此模組）：
  1. 背景迴圈每 LIGHTRADE_ORDER_SYNC_INTERVAL 秒（預設 2.5，0=停用）
     在 broker thread 上 update_status + list_trades
  2. 活躍委託快照有變化 → 直接推播 `WorkingOrdersSnapshot` 給前端
     （帶 snapshot seq，前端沿用既有的 seq 防亂序機制，不用再打 REST）
  3. 從 trades 的 deals 對帳出「journal 還沒有的成交」（含外部成交）：
     - 落地 journal（id = ordno#seq，與 callback 路徑天然去重）
     - 觸發已實現損益重算（風控熔斷資料源）
     - 作廢持倉快取 + 推播 TradeUpdate（前端成交通知/刷新）
     - 發射 on_fill（Bracket 母單成交在 callback 漏接時的補償）
"""
import asyncio
import json
import logging
import os
import time

from backend import shared
from backend.services import trade_journal

logger = logging.getLogger(__name__)

SYNC_INTERVAL_S = float(os.environ.get("LIGHTRADE_ORDER_SYNC_INTERVAL", "2.5"))

ACTIVE_STATUSES = {"PendingSubmit", "PreSubmitted", "Submitted", "PartFilled"}

_last_fingerprint: str = ""
# 本 session 已處理過的 fill id（in-memory watermark）：
# 沒有它，每 2.5 秒會對「當天全部 deals」各打一次 INSERT OR IGNORE，
# 活躍日尾盤等於每輪數百次無效的 SQLite 寫鎖競爭
_seen_fill_ids: set = set()


def build_working_orders(trades) -> list[dict]:
    """
    從 shioaji list_trades() 結果建活躍委託快照。
    orders.py / accounts.sync_all / 對帳迴圈共用（之前三處各自複製）。
    """
    working = []
    for t in trades or []:
        try:
            status_name = (t.status.status.name if hasattr(t.status, "status")
                           else getattr(t.status, "name", "Unknown"))
            if status_name not in ACTIVE_STATUSES:
                continue
            raw_symbol = getattr(t.contract, "symbol", "") or getattr(t.contract, "code", "")
            action = str(getattr(t.order, "action", ""))
            working.append({
                "symbol": raw_symbol,
                "action": "Buy" if "Buy" in action else "Sell",
                "price": float(t.order.price),
                "qty": t.order.quantity,
                "filled_qty": getattr(t.status, "deal_quantity",
                                      getattr(t.status, "filled_quantity", 0)),
                "status": status_name,
                "order_id": getattr(t.order, "id", getattr(t.order, "seqno", "")),
            })
        except Exception as e:
            logger.debug(f"order_sync 略過異常 trade: {e}")
    return working


def build_broker_order_index(trades) -> list[dict]:
    """
    從 list_trades() 建「全部委託」（含已成交/已取消）的對帳索引，
    給 SmartOrderEngine.sync_broker_orders 用：
      - CHASE 掛單消失/被外部撤 → CANCELLED_EXTERNAL
      - 重啟後 re-attach（ordno 對上活躍掛單 → 續追）
      - 成交量補償（callback 漏接時以券商 deal_quantity 為準）
    """
    out = []
    for t in trades or []:
        try:
            status_name = (t.status.status.name if hasattr(t.status, "status")
                           else getattr(t.status, "name", "Unknown"))
            order = getattr(t, "order", None)
            ids = []
            for attr in ("id", "seqno", "ordno"):
                v = getattr(order, attr, None)
                if v:
                    ids.append(str(v))
            if not ids:
                continue
            out.append({
                "ids": ids,
                "status": status_name,
                "filled_qty": int(getattr(t.status, "deal_quantity",
                                          getattr(t.status, "filled_quantity", 0)) or 0),
            })
        except Exception as e:
            logger.debug(f"order_sync 略過異常 trade（index）: {e}")
    return out


def _ts_to_ms(ts) -> int:
    """shioaji Deal.ts 可能是 秒 / 毫秒 / 奈秒，統一轉毫秒。"""
    try:
        v = float(ts)
    except (TypeError, ValueError):
        return int(time.time() * 1000)
    if v <= 0:
        return int(time.time() * 1000)
    if v > 1e15:      # 奈秒
        return int(v // 1e6)
    if v > 1e11:      # 已是毫秒
        return int(v)
    return int(v * 1000)  # 秒


def extract_deal_fills(trades) -> list[dict]:
    """從 trades 的 status.deals 展開成 journal 標準 fill dict。

    id = ordno#seq —— 與 callback 路徑（extract_fill 的 dealseq/seq）對齊，
    INSERT OR IGNORE 天然去重，同一筆成交不會被記兩次。
    """
    fills = []
    for t in trades or []:
        try:
            order = getattr(t, "order", None)
            ordno = (getattr(order, "ordno", "") or getattr(order, "seqno", "")
                     or getattr(order, "id", "") or "")
            symbol = getattr(t.contract, "code", "") or getattr(t.contract, "symbol", "")
            action = "Buy" if "Buy" in str(getattr(order, "action", "")) else "Sell"
            for d in getattr(t.status, "deals", None) or []:
                price = float(getattr(d, "price", 0) or 0)
                qty = int(getattr(d, "quantity", 0) or 0)
                if price <= 0 or qty <= 0 or not symbol:
                    continue
                seq = getattr(d, "seq", "") or ""
                ts_ms = _ts_to_ms(getattr(d, "ts", 0))
                fills.append({
                    "id": f"{ordno or 'noid'}#{seq or ts_ms}",
                    "ts": ts_ms,
                    "symbol": str(symbol).upper(),
                    "action": action,
                    "price": price,
                    "qty": qty,
                    "order_id": str(ordno),
                    "raw": json.dumps({"source": "order_sync", "seq": str(seq)}),
                })
        except Exception as e:
            logger.debug(f"order_sync 略過異常 deal: {e}")
    return fills


def _broadcast(item: dict) -> None:
    """丟進既有的廣播佇列（quote_broadcaster 會送給所有 WS 客戶端）。"""
    try:
        shared.quotes_to_broadcast.put_nowait(item)
    except Exception as e:
        logger.warning(f"order_sync 廣播失敗: {e}")


async def sync_once() -> dict:
    """執行一輪對帳。回傳 {changed, new_fills} 供測試驗證。"""
    global _last_fingerprint
    client = shared.shioaji_client
    if not client or not getattr(client, "_is_connected", False):
        return {"changed": False, "new_fills": 0}

    def _pull():
        # 只做 per-account update_status（不走 client.update_status —— 那會
        # 順便 trigger_account_update，每輪都廣播帳務太吵）
        # ★ P1-4a：任一帳號 update_status 失敗 → 本輪快照「不完整」，
        #   list_trades 可能只涵蓋部分帳號、缺席不可信 → 標記給對帳路徑，
        #   避免據不完整快照把 chase 誤判為外部撤單。
        complete = True
        try:
            for acc in client.api.list_accounts():
                try:
                    client.api.update_status(acc)
                except Exception:
                    complete = False
            return client.api.list_trades(), complete
        except Exception as e:
            logger.warning(f"order_sync 向券商同步失敗: {e}")
            return None, False

    # ★ 走專用 sync executor —— update_status×N + list_trades 每 2.5 秒
    #   一輪，若與手動下單共用 broker 佇列會造成 head-of-line 延遲尖峰
    trades, snapshot_complete = await shared.run_in_sync_thread(_pull)
    if trades is None:
        return {"changed": False, "new_fills": 0}

    # 1. 活躍委託快照 → 有變化才推播
    working = build_working_orders(trades)
    fingerprint = json.dumps(working, sort_keys=True, default=str)
    changed = fingerprint != _last_fingerprint
    if changed:
        _last_fingerprint = fingerprint
        _broadcast({
            "type": "WorkingOrdersSnapshot",
            "seq_no": shared.generate_snapshot_seq(),
            "seq_kind": "snapshot",
            "data": {"orders": working},
        })
        logger.info(f"order_sync: 活躍委託變化 → 推播快照（{len(working)} 筆）")

    # 2. 對帳成交（含外部管道）→ journal / 風控 / 前端通知
    from backend.services.order_guard import fill_side_effects
    new_fills = 0
    for fill in extract_deal_fills(trades):
        if fill["id"] in _seen_fill_ids:
            continue  # 本 session 已處理過，不再打 SQLite
        _seen_fill_ids.add(fill["id"])
        if not trade_journal.insert_fill(fill):
            continue  # journal 已有（本 session callback 已記過）
        new_fills += 1
        logger.info(f"order_sync: 對帳到新成交 {fill['symbol']} "
                    f"{fill['action']} {fill['qty']} @ {fill['price']}")
        _broadcast({"type": "TradeUpdate", "data": {
            **fill, "code": fill["symbol"], "quantity": fill["qty"],
            "state": "SyncDeal", "source": "order_sync",
        }})
        # 共用副作用：on_fill（bracket 補償）/ PnL 快取作廢 / 已實現重算排程
        fill_side_effects(fill)

    # 3. CHASE 智慧單對帳：外部撤單偵測 / 重啟 re-attach / 成交量補償
    #    （放在 fills 之後：同一輪看到的成交先入帳，再判斷掛單是否消失）
    try:
        smart_eng = getattr(shared.engine, "smart_order_engine", None) if shared.engine else None
        if smart_eng is not None and hasattr(smart_eng, "sync_broker_orders"):
            smart_eng.sync_broker_orders(build_broker_order_index(trades),
                                         snapshot_complete=snapshot_complete)
    except Exception as e:
        logger.warning(f"order_sync 智慧單對帳失敗: {e}")

    return {"changed": changed, "new_fills": new_fills}


async def order_sync_loop():
    """背景對帳迴圈（main.py lifespan 啟動）。"""
    if SYNC_INTERVAL_S <= 0:
        logger.info("order_sync 已停用（LIGHTRADE_ORDER_SYNC_INTERVAL<=0）")
        return
    logger.info(f"★ 委託對帳迴圈已啟動（每 {SYNC_INTERVAL_S}s，外部管道下單即時同步）")
    while True:
        try:
            await asyncio.sleep(SYNC_INTERVAL_S)
            await sync_once()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"order_sync 迴圈錯誤: {e}", exc_info=True)
            await asyncio.sleep(SYNC_INTERVAL_S)
