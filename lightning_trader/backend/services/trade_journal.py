"""
trade_journal.py — 把每筆成交回報落地到 SQLite

設計：
  - DB path：env `LIGHTRADE_JOURNAL_DB` 覆寫；預設 `~/.lightrade/journal.db`
  - 純 stdlib `sqlite3`，零外部依賴
  - 寫入呼叫從 bridge.on_shioaji_trade_update 觸發，要極短不能阻塞
    → 用 lock 序列化單一寫，但每筆 < 1ms 不會卡到 tick 路徑
  - Read API（給 router）：fetch_fills(from_ts, to_ts, symbol, limit)

Schema：
  fills(
    id TEXT PRIMARY KEY,    -- order_id|seq_no 或 raw msg hash
    ts INTEGER NOT NULL,    -- unix ms
    symbol TEXT NOT NULL,
    action TEXT NOT NULL,
    price REAL NOT NULL,
    qty INTEGER NOT NULL,
    order_id TEXT,
    raw TEXT,               -- 原始 JSON，留作後續修補
    created_at INTEGER NOT NULL
  )
"""
from __future__ import annotations
import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DB_LOCK = threading.Lock()
_CONN: Optional[sqlite3.Connection] = None

# 縱深防禦：內容型防重的近接時窗（毫秒）。權威鍵去重是第一道防線，
# 這是「同一筆成交在兩條路徑產生了不同 id」時的第二道防線。
# 需覆蓋 callback 與 order_sync 對帳（每 SYNC_INTERVAL_S≈2.5s 一輪）之間的
# 觀測時間差，故預設 2000ms。可用環境變數覆寫。
_DEDUP_WINDOW_MS = int(os.environ.get("LIGHTRADE_FILL_DEDUP_WINDOW_MS", "2000") or 2000)


def _norm_price_key(price) -> str:
    """把價格正規化成穩定字串，讓兩條路徑（int 17050 vs float 17050.0）產生同鍵。"""
    try:
        return f"{float(price):.6f}"
    except (TypeError, ValueError):
        return "0.000000"


def authoritative_fill_id(order_id, *, seq=None, price=None,
                          qty=None, cum_qty=None) -> str:
    """
    單一決定性「權威成交鍵」——callback 落地路徑（extract_fill）與 order_sync
    對帳路徑（extract_deal_fills）共用同一份邏輯，確保同一筆成交在兩條路徑
    推導出**同一個 id**，INSERT OR IGNORE 才能正確去重。

    優先序：
      1. `ordno + 交易所成交序號`（exchange_seq / Deal.seq）—— 最穩固。
      2. 缺序號 → 內容組合鍵 `ordno#price#qty#該單當下累計成交量`，
         兩條路徑各自都能推導出同一鍵（cum_qty：callback 帶累計欄、
         order_sync 走 deals list 累加）。

    ★ 絕不使用 wall-clock（time.time()）：那會讓同一筆成交在兩路徑取得不同鍵，
      去重失效 → 成交重複入帳 → 日已實現損益翻倍。
    ★ 不可用 seqno（委託序號）當去重序號：同一單的多筆部分成交會撞成一筆。
    """
    oid = str(order_id or "noid")
    s = "" if seq is None else str(seq).strip()
    if s:
        return f"{oid}#{s}"
    # 退回內容組合鍵（決定性、無 wall-clock）
    p = _norm_price_key(price)
    try:
        q = int(qty or 0)
    except (TypeError, ValueError):
        q = 0
    if cum_qty in (None, ""):
        c = q
    else:
        try:
            c = int(cum_qty)
        except (TypeError, ValueError):
            c = q
    return f"{oid}#{p}#{q}#{c}"


def _db_path() -> Path:
    raw = os.environ.get("LIGHTRADE_JOURNAL_DB")
    if raw:
        return Path(raw)
    return Path.home() / ".lightrade" / "journal.db"


def _connect() -> sqlite3.Connection:
    global _CONN
    if _CONN is not None:
        return _CONN
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")  # 多執行緒併發友好
    conn.execute("""
        CREATE TABLE IF NOT EXISTS fills (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            action TEXT NOT NULL,
            price REAL NOT NULL,
            qty INTEGER NOT NULL,
            order_id TEXT,
            raw TEXT,
            created_at INTEGER NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fills_ts ON fills(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_fills_symbol ON fills(symbol)")
    _ensure_columns(conn)
    _CONN = conn
    logger.info(f"📓 trade journal opened: {path}")
    return conn


def _ensure_columns(conn: sqlite3.Connection) -> None:
    """Sprint 32：對既有 DB 補上 tag / notes 欄（idempotent migration）。"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(fills)").fetchall()}
    if "tag" not in cols:
        conn.execute("ALTER TABLE fills ADD COLUMN tag TEXT")
    if "notes" not in cols:
        conn.execute("ALTER TABLE fills ADD COLUMN notes TEXT")


def extract_fill(trade_data: dict) -> Optional[dict]:
    """
    從 Shioaji order/trade callback dict 抽出我們關心的欄位。
    Shioaji 的 callback msg 沒有單一 schema，這裡盡量寬鬆。
    回 None 代表本筆不是成交（例如純狀態變更），跳過。
    """
    if not isinstance(trade_data, dict):
        return None

    # state 標記是否為「Deal」（成交）— 不同版本欄位略異
    state = str(trade_data.get("state", "") or trade_data.get("operation", "")).lower()
    if state and "deal" not in state and "fill" not in state:
        return None

    # 嘗試多個 path 取資料
    order = trade_data.get("order", {}) or {}
    contract = trade_data.get("contract", {}) or {}
    symbol = (
        trade_data.get("code") or trade_data.get("symbol")
        or contract.get("code") or contract.get("symbol")
        or order.get("code") or order.get("symbol")
        or ""
    )
    action = (
        trade_data.get("action") or order.get("action")
        or trade_data.get("buy_sell") or ""
    )
    price = trade_data.get("price") or trade_data.get("deal_price") or order.get("price") or 0
    qty = (
        trade_data.get("quantity") or trade_data.get("qty")
        or trade_data.get("deal_quantity") or order.get("quantity") or 0
    )
    order_id = (
        trade_data.get("ordno") or trade_data.get("seqno")
        or order.get("ordno") or order.get("seqno") or ""
    )

    try:
        price = float(price)
        qty = int(qty)
    except (TypeError, ValueError):
        return None
    if price <= 0 or qty <= 0 or not symbol:
        return None

    # 唯一 id：走共用的權威鍵 helper（與 order_sync 對帳路徑同一份邏輯）。
    #   優先 ordno + exchange_seq/Deal.seq；缺序號退回內容組合鍵。
    #   ★ 絕不用 wall-clock —— 否則同一筆成交兩路徑 id 不同、去重失效、
    #     日已實現損益翻倍。詳見 authoritative_fill_id docstring。
    deal_seq = (trade_data.get("exchange_seq") or trade_data.get("dealseq")
                or trade_data.get("seq"))
    # 該單當下累計成交量（多筆部分成交時用來區分同價同量的兩筆）：
    # 優先取回報帶的累計欄，缺則退回本筆量（單筆成交時累計==本筆）。
    cum_qty = (trade_data.get("cum_quantity") or trade_data.get("cum_qty")
               or trade_data.get("total_quantity"))
    fill_id = authoritative_fill_id(order_id, seq=deal_seq, price=price,
                                    qty=qty, cum_qty=cum_qty)

    return {
        "id": fill_id,
        "ts": int(time.time() * 1000),
        "symbol": str(symbol).upper(),
        "action": "Buy" if str(action).lower() in ("b", "buy") else "Sell",
        "price": price,
        "qty": qty,
        "order_id": str(order_id or ""),
        "raw": json.dumps(trade_data, default=str),
        "created_at": int(time.time() * 1000),
    }


def record_trade(trade_data: dict) -> bool:
    """從 bridge 呼叫；non-blocking 用法請呼叫端自行 wrap thread。回傳是否成功落地。"""
    fill = extract_fill(trade_data)
    if fill is None:
        return False
    try:
        with _DB_LOCK:
            conn = _connect()
            conn.execute(
                "INSERT OR IGNORE INTO fills (id, ts, symbol, action, price, qty, order_id, raw, created_at)"
                " VALUES (:id, :ts, :symbol, :action, :price, :qty, :order_id, :raw, :created_at)",
                fill,
            )
        return True
    except Exception as e:
        logger.error(f"trade_journal.record_trade 失敗: {e}")
        return False


def insert_fill(fill: dict) -> bool:
    """
    對帳器（order_sync）用：直接寫入標準化 fill dict。
    回傳是否為「新」列（journal 已有同 id 則 False，callback 路徑天然去重）。
    """
    row = {
        "id": str(fill.get("id") or ""),
        "ts": int(fill.get("ts") or time.time() * 1000),
        "symbol": str(fill.get("symbol") or "").upper(),
        "action": "Buy" if str(fill.get("action", "")).lower() in ("b", "buy") else "Sell",
        "price": float(fill.get("price") or 0),
        "qty": int(fill.get("qty") or 0),
        "order_id": str(fill.get("order_id") or ""),
        "raw": fill.get("raw") or "",
        "created_at": int(time.time() * 1000),
    }
    if not row["id"] or not row["symbol"] or row["price"] <= 0 or row["qty"] <= 0:
        return False
    try:
        with _DB_LOCK:
            conn = _connect()
            # 縱深防禦：即使 id 不同，同 order_id+price+qty 且時間近接視為同一筆
            #   —— 針對「某一路徑缺序號、退回內容鍵，另一路徑有序號」導致兩路徑
            #   id 分歧、權威鍵去重失效的情形兜底。
            #   ★ 但兩邊都是「序號鍵」(ordno#seq) 且不同時，代表是同單同價的兩筆
            #     真實部分成交（交易所給了不同序號）→ 不可誤併，照常各自入帳。
            dup_id = _near_duplicate_id(conn, row)
            if dup_id is not None and dup_id != row["id"] \
                    and not (_is_seq_id(dup_id) and _is_seq_id(row["id"])):
                logger.info(
                    f"trade_journal.insert_fill 內容型防重命中，略過 {row['symbol']} "
                    f"{row['action']} {row['qty']}@{row['price']} "
                    f"(id={row['id']} ≈ 既有 {dup_id})"
                )
                return False
            cur = conn.execute(
                "INSERT OR IGNORE INTO fills (id, ts, symbol, action, price, qty, order_id, raw, created_at)"
                " VALUES (:id, :ts, :symbol, :action, :price, :qty, :order_id, :raw, :created_at)",
                row,
            )
        return cur.rowcount > 0
    except Exception as e:
        logger.error(f"trade_journal.insert_fill 失敗: {e}")
        return False


def _is_seq_id(fill_id: str) -> bool:
    """
    序號鍵 = `ordno#seq`（authoritative_fill_id 第 1 優先）→ 恰含 1 個 '#'。
    內容鍵 = `ordno#price#qty#cum`（退回鍵）→ 含 3 個 '#'。
    兩邊都是序號鍵才代表交易所給了不同序號的兩筆真實成交，內容防重需放行。
    """
    return str(fill_id).count("#") == 1


def _near_duplicate_id(conn: sqlite3.Connection, row: dict) -> Optional[str]:
    """
    內容型防重查詢：同 order_id + price + qty 且 |ts 差| <= 時窗，回傳既有列 id。
    無 order_id（例如外部成交無 ordno）時不做內容防重（避免把不相關成交誤併），
    改由權威鍵 / 序號那一層負責。
    """
    if not row.get("order_id"):
        return None
    try:
        r = conn.execute(
            "SELECT id FROM fills WHERE order_id = ? AND price = ? AND qty = ? "
            "AND ABS(ts - ?) <= ? LIMIT 1",
            (row["order_id"], row["price"], row["qty"], row["ts"], _DEDUP_WINDOW_MS),
        ).fetchone()
        return r[0] if r else None
    except Exception:
        return None


def fetch_fills(from_ts: Optional[int] = None, to_ts: Optional[int] = None,
                symbol: Optional[str] = None, limit: int = 500) -> list[dict]:
    """讀取近期成交。ts 為 unix ms。"""
    where: list[str] = []
    args: list = []
    if from_ts is not None:
        where.append("ts >= ?"); args.append(int(from_ts))
    if to_ts is not None:
        where.append("ts <= ?"); args.append(int(to_ts))
    if symbol:
        where.append("symbol = ?"); args.append(symbol.upper())
    sql = "SELECT id, ts, symbol, action, price, qty, order_id, tag, notes FROM fills"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts DESC LIMIT ?"
    args.append(max(1, min(5000, int(limit))))
    try:
        with _DB_LOCK:
            conn = _connect()
            rows = conn.execute(sql, args).fetchall()
        cols = ["id", "ts", "symbol", "action", "price", "qty", "order_id", "tag", "notes"]
        return [dict(zip(cols, r)) for r in rows]
    except Exception as e:
        logger.error(f"trade_journal.fetch_fills 失敗: {e}")
        return []


def fetch_fills_for_fifo(from_ts: Optional[int] = None,
                         symbol: Optional[str] = None,
                         hard_cap: int = 500_000) -> list[dict]:
    """
    FIFO 重建專用：以 ts **升序**回傳，且**不套 fetch_fills 的 5000 截斷**。

    為什麼另開一支：refresh_daily_realized 需要用完整歷史重建 open_lots。
    若沿用 fetch_fills（LIMIT 5000 + 近端優先），久遠的開倉腳會被截掉 →
    今日平倉配不到反向倉 → 被當新開倉 delta=0 → 已實現虧損漏計 → 熔斷被繞過。
    這裡改抓齊（升序、只設一個很寬的 hard_cap 護欄防記憶體爆掉）。
    """
    where: list[str] = []
    args: list = []
    if from_ts is not None:
        where.append("ts >= ?"); args.append(int(from_ts))
    if symbol:
        where.append("symbol = ?"); args.append(symbol.upper())
    sql = "SELECT id, ts, symbol, action, price, qty, order_id, tag, notes FROM fills"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts ASC LIMIT ?"
    args.append(max(1, int(hard_cap)))
    try:
        with _DB_LOCK:
            conn = _connect()
            rows = conn.execute(sql, args).fetchall()
        cols = ["id", "ts", "symbol", "action", "price", "qty", "order_id", "tag", "notes"]
        return [dict(zip(cols, r)) for r in rows]
    except Exception as e:
        logger.error(f"trade_journal.fetch_fills_for_fifo 失敗: {e}")
        return []


def update_fill_meta(fill_id: str, tag: Optional[str] = None,
                     notes: Optional[str] = None) -> bool:
    """
    Sprint 32：替某筆成交標記策略 tag / 寫紀律檢討 notes。
    tag/notes 任一為 None 代表「不更動該欄」；空字串代表「清空」。
    回傳是否有更新到列（fill_id 不存在 → False）。
    """
    if not fill_id:
        return False
    sets: list[str] = []
    args: list = []
    if tag is not None:
        sets.append("tag = ?"); args.append(str(tag)[:64])
    if notes is not None:
        sets.append("notes = ?"); args.append(str(notes)[:500])
    if not sets:
        return False
    args.append(str(fill_id))
    try:
        with _DB_LOCK:
            conn = _connect()
            cur = conn.execute(
                f"UPDATE fills SET {', '.join(sets)} WHERE id = ?", args
            )
        return cur.rowcount > 0
    except Exception as e:
        logger.error(f"trade_journal.update_fill_meta 失敗: {e}")
        return False


def import_fills(rows: list[dict]) -> dict:
    """
    Sprint 24：批次匯入既有成交（給 CSV import 用）。
    每筆 row 需要 ts(ms) / symbol / action / price / qty；order_id 可選。
    回傳 {accepted, skipped, errors[]}。已存在的 id 走 INSERT OR IGNORE 不會重複。
    """
    import time as _t
    accepted = 0
    skipped = 0
    errors: list[str] = []
    if not rows:
        return {"accepted": 0, "skipped": 0, "errors": []}
    try:
        with _DB_LOCK:
            conn = _connect()
            for i, r in enumerate(rows):
                try:
                    ts = int(r.get("ts") or 0)
                    symbol = str(r.get("symbol") or "").strip().upper()
                    action = str(r.get("action") or "").strip()
                    price = float(r.get("price") or 0)
                    qty = int(float(r.get("qty") or 0))
                    order_id = str(r.get("order_id") or "")
                    if ts <= 0 or not symbol or price <= 0 or qty <= 0:
                        skipped += 1
                        continue
                    if action.lower() in ("b", "buy"):
                        action = "Buy"
                    elif action.lower() in ("s", "sell"):
                        action = "Sell"
                    else:
                        skipped += 1
                        continue
                    # 自動生成 id：用 order_id + ts + symbol 組成（不易撞）
                    fill_id = r.get("id") or f"imp:{order_id}#{ts}#{symbol}#{action}#{price}#{qty}"
                    conn.execute(
                        "INSERT OR IGNORE INTO fills (id, ts, symbol, action, price, qty, order_id, raw, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (str(fill_id), ts, symbol, action, price, qty, order_id, "", int(_t.time() * 1000)),
                    )
                    accepted += 1
                except Exception as e:
                    errors.append(f"row {i}: {e}")
        return {"accepted": accepted, "skipped": skipped, "errors": errors[:10]}
    except Exception as e:
        logger.error(f"import_fills 失敗: {e}")
        return {"accepted": accepted, "skipped": skipped, "errors": [str(e)] + errors[:9]}


def fetch_stats(from_ts: Optional[int] = None, to_ts: Optional[int] = None) -> dict:
    """總筆數、最早最新時間、買賣口數。粗估 PnL 不在這層做，避免重複實作。"""
    where: list[str] = []
    args: list = []
    if from_ts is not None:
        where.append("ts >= ?"); args.append(int(from_ts))
    if to_ts is not None:
        where.append("ts <= ?"); args.append(int(to_ts))
    sql_base = "FROM fills" + ((" WHERE " + " AND ".join(where)) if where else "")
    try:
        with _DB_LOCK:
            conn = _connect()
            count = conn.execute("SELECT COUNT(*) " + sql_base, args).fetchone()[0]
            agg = conn.execute(
                "SELECT MIN(ts), MAX(ts), "
                "SUM(CASE WHEN action='Buy'  THEN qty ELSE 0 END), "
                "SUM(CASE WHEN action='Sell' THEN qty ELSE 0 END) "
                + sql_base, args).fetchone()
            symbols = conn.execute(
                "SELECT symbol, COUNT(*) AS n " + sql_base + " GROUP BY symbol ORDER BY n DESC LIMIT 5",
                args,
            ).fetchall()
            tags = conn.execute(
                "SELECT COALESCE(NULLIF(tag, ''), '(未標記)') AS t, COUNT(*) AS n "
                + sql_base + " GROUP BY t ORDER BY n DESC LIMIT 10",
                args,
            ).fetchall()
        return {
            "fills": int(count or 0),
            "first_ts": int(agg[0]) if agg[0] else None,
            "last_ts": int(agg[1]) if agg[1] else None,
            "buy_lots": int(agg[2] or 0),
            "sell_lots": int(agg[3] or 0),
            "top_symbols": [{"symbol": s, "fills": n} for s, n in symbols],
            "by_tag": [{"tag": t, "fills": n} for t, n in tags],
        }
    except Exception as e:
        logger.error(f"trade_journal.fetch_stats 失敗: {e}")
        return {"fills": 0}
