"""
audit_log.py — 委託生命週期審計軌（WS4）

把每個委託在系統內的關鍵生命週期事件落地到獨立的 SQLite 表，
供事後稽核 / 對帳 / 監理留痕。與 trade_journal 的 `fills` 表刻意分開
（獨立 DB、獨立表），彼此互不影響：

  - trade_journal.fills：只記「成交」，是已實現損益 / FIFO 重算的資料源。
  - audit_log.audit   ：記整條委託軌跡（intent → risk → sent → ack → fill →
    cancel），是「這筆單為什麼被送出 / 為什麼被擋 / 何時到哪個狀態」的稽核軌。

設計原則（與 trade_journal 一致）：
  - DB path：env `LIGHTRADE_AUDIT_DB` 覆寫；預設 `~/.lightrade/audit.db`
  - 純 stdlib `sqlite3`，零外部依賴
  - `_DB_LOCK` 序列化單一寫，autocommit（isolation_level=None）
  - `record(...)` 極短（< 1ms），可從下單熱路徑（order_guard）直呼而不卡 tick
  - 介面穩定：本模組只提供 storage + query，**不**自己去 order_guard 埋點
    （order_guard 由 WS1 組獨占）；WS1 從 order_guard 呼叫 `record(...)`。

Schema：
  audit(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,   -- unix ms（事件發生時間）
    event_type TEXT NOT NULL,      -- intent/risk_pass/risk_block/sent/ack/fill/cancel/...
    order_id   TEXT,               -- 券商委託序號（ordno/seqno），下單前可為 None
    symbol     TEXT,
    action     TEXT,               -- Buy / Sell
    qty        INTEGER,
    price      REAL,
    meta       TEXT,               -- 任意 JSON（拒單原因 / 風控快照 / 原始回報…）
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

# ── 已知事件型別（僅作文件/協助用途，record 不強制限制，允許未來擴充）──
EVENT_INTENT = "intent"          # 使用者/策略意圖下單（尚未過風控）
EVENT_RISK_PASS = "risk_pass"    # 風控放行
EVENT_RISK_BLOCK = "risk_block"  # 風控攔截（meta 帶原因）
EVENT_SENT = "sent"              # 已送出到券商
EVENT_ACK = "ack"                # 券商受理（委託成立）
EVENT_FILL = "fill"             # 成交（部分/全部）
EVENT_CANCEL = "cancel"          # 撤單

_DB_LOCK = threading.Lock()
_CONN: Optional[sqlite3.Connection] = None


def _db_path() -> Path:
    raw = os.environ.get("LIGHTRADE_AUDIT_DB")
    if raw:
        return Path(raw)
    return Path.home() / ".lightrade" / "audit.db"


def _connect() -> sqlite3.Connection:
    global _CONN
    if _CONN is not None:
        return _CONN
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None → autocommit；check_same_thread=False → 允許多執行緒共用
    conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")  # 多執行緒併發友好
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            order_id TEXT,
            symbol TEXT,
            action TEXT,
            qty INTEGER,
            price REAL,
            meta TEXT,
            created_at INTEGER NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_order ON audit(order_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_event ON audit(event_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_symbol ON audit(symbol)")
    _CONN = conn
    logger.info(f"🧾 audit log opened: {path}")
    return conn


def record(event_type: str, *,
           order_id=None, symbol=None, action=None,
           qty=None, price=None, meta=None) -> Optional[int]:
    """
    記一筆委託生命週期事件。穩定介面 —— 供 order_guard（WS1 掛鉤）與其他
    熱路徑直呼。落地極短、失敗只記 log 不拋（絕不因稽核落地失敗擋下單）。

    參數皆為關鍵字（除 event_type）：
      event_type : intent/risk_pass/risk_block/sent/ack/fill/cancel（見 EVENT_*）
      order_id   : 券商委託序號；下單前（intent/risk_*）可為 None
      symbol     : 商品代碼
      action     : "Buy" / "Sell"
      qty, price : 數量 / 價格
      meta       : dict 或可 JSON 序列化物件（拒單原因、風控快照、原始回報…）

    回傳：新列 rowid（int）；失敗回 None。
    """
    if not event_type:
        return None
    try:
        row = {
            "ts": int(time.time() * 1000),
            "event_type": str(event_type),
            "order_id": None if order_id is None else str(order_id),
            "symbol": None if symbol is None else str(symbol),
            "action": None if action is None else str(action),
            "qty": None if qty is None else int(qty),
            "price": None if price is None else float(price),
            "meta": None if meta is None else json.dumps(meta, default=str),
            "created_at": int(time.time() * 1000),
        }
    except (TypeError, ValueError) as e:
        logger.warning(f"audit_log.record 參數正規化失敗（event={event_type}）: {e}")
        # 退化：至少把型別與原始 meta 以字串留痕，不丟事件
        row = {
            "ts": int(time.time() * 1000),
            "event_type": str(event_type),
            "order_id": None if order_id is None else str(order_id),
            "symbol": None if symbol is None else str(symbol),
            "action": None if action is None else str(action),
            "qty": None,
            "price": None,
            "meta": json.dumps({"_raw_meta": str(meta), "_error": str(e)}),
            "created_at": int(time.time() * 1000),
        }
    try:
        with _DB_LOCK:
            conn = _connect()
            cur = conn.execute(
                "INSERT INTO audit (ts, event_type, order_id, symbol, action, qty, price, meta, created_at)"
                " VALUES (:ts, :event_type, :order_id, :symbol, :action, :qty, :price, :meta, :created_at)",
                row,
            )
        return int(cur.lastrowid)
    except Exception as e:
        logger.error(f"audit_log.record 落地失敗（event={event_type}）: {e}")
        return None


_COLS = ["id", "ts", "event_type", "order_id", "symbol", "action", "qty", "price", "meta"]


def query(event_type: Optional[str] = None,
          order_id: Optional[str] = None,
          symbol: Optional[str] = None,
          from_ts: Optional[int] = None,
          to_ts: Optional[int] = None,
          limit: int = 500,
          ascending: bool = False) -> list[dict]:
    """
    讀取審計事件（供端點/稽核）。ts 為 unix ms。

      event_type / order_id / symbol : 精確過濾（None 代表不過濾）
      from_ts / to_ts                : 時間區間（含端點）
      limit                          : 上限（1..5000）
      ascending                      : 預設 False（新→舊）；追一筆單的軌跡時
                                       常用 True 依時間正序看整條生命週期

    `meta` 欄自動反序列化回 dict（無法解析則保留原字串）。
    """
    where: list[str] = []
    args: list = []
    if event_type:
        where.append("event_type = ?"); args.append(str(event_type))
    if order_id:
        where.append("order_id = ?"); args.append(str(order_id))
    if symbol:
        where.append("symbol = ?"); args.append(str(symbol))
    if from_ts is not None:
        where.append("ts >= ?"); args.append(int(from_ts))
    if to_ts is not None:
        where.append("ts <= ?"); args.append(int(to_ts))
    sql = "SELECT id, ts, event_type, order_id, symbol, action, qty, price, meta FROM audit"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY ts %s, id %s LIMIT ?" % (
        ("ASC", "ASC") if ascending else ("DESC", "DESC")
    )
    args.append(max(1, min(5000, int(limit))))
    try:
        with _DB_LOCK:
            conn = _connect()
            rows = conn.execute(sql, args).fetchall()
        out: list[dict] = []
        for r in rows:
            d = dict(zip(_COLS, r))
            if d.get("meta"):
                try:
                    d["meta"] = json.loads(d["meta"])
                except (TypeError, ValueError):
                    pass  # 保留原字串
            out.append(d)
        return out
    except Exception as e:
        logger.error(f"audit_log.query 失敗: {e}")
        return []


def order_trail(order_id: str, limit: int = 500) -> list[dict]:
    """某筆委託的完整生命週期軌跡（依時間正序）。稽核端點常用捷徑。"""
    if not order_id:
        return []
    return query(order_id=order_id, limit=limit, ascending=True)


def _reset_for_tests() -> None:
    """測試專用：關閉並清掉快取連線，讓下次 _connect 依（可能剛換的）
    LIGHTRADE_AUDIT_DB 重新開檔。正式路徑不會呼叫。"""
    global _CONN
    with _DB_LOCK:
        if _CONN is not None:
            try:
                _CONN.close()
            except Exception:
                pass
        _CONN = None
