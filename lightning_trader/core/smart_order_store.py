"""
smart_order_store.py — 智慧單 SQLite 持久化

停損 / 移動停損 / OCO / Bracket 之前只存在記憶體，backend 重啟或當機後
所有保護單會無聲消失。這裡把智慧單落地到 SQLite，開機時由
SmartOrderEngine 重新掛載（re-arm）仍為 active 的單。

設計：
  - DB path：env `LIGHTRADE_SMART_ORDERS_DB` 覆寫；預設 `~/.lightrade/smart_orders.db`
  - 純 stdlib sqlite3，寫入以 lock 序列化（與 trade_journal 相同模式）
  - 每張單存成一列 JSON（schema 演進成本最低），id 為主鍵 upsert
  - trailing 的 watermark **不持久化**：重啟後從當下市價重新追蹤，
    避免每個 tick 都寫 DB；語意上等同重新掛一張移動停損
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


def default_db_path() -> Path:
    raw = os.environ.get("LIGHTRADE_SMART_ORDERS_DB")
    if raw:
        return Path(raw)
    return Path.home() / ".lightrade" / "smart_orders.db"


class SmartOrderStore:
    """智慧單持久化。path=None 時為 no-op（測試 / 不需要持久化的場景）。"""

    def __init__(self, path: Optional[Path] = None):
        self._path = path
        self._lock = threading.Lock()
        self._conn: Optional[sqlite3.Connection] = None

    @property
    def enabled(self) -> bool:
        return self._path is not None

    def _connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._path), check_same_thread=False, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS smart_orders (
                id TEXT PRIMARY KEY,
                is_active INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)
        self._conn = conn
        logger.info(f"🛡️ smart order store opened: {self._path}")
        return conn

    def save(self, order_dict: dict) -> None:
        """upsert 一張智慧單（add / cancel / trigger 時呼叫）。"""
        if not self.enabled:
            return
        try:
            with self._lock:
                conn = self._connect()
                conn.execute(
                    "INSERT INTO smart_orders (id, is_active, payload, updated_at)"
                    " VALUES (?, ?, ?, ?)"
                    " ON CONFLICT(id) DO UPDATE SET"
                    "   is_active=excluded.is_active,"
                    "   payload=excluded.payload,"
                    "   updated_at=excluded.updated_at",
                    (
                        str(order_dict.get("id")),
                        1 if order_dict.get("is_active") else 0,
                        json.dumps(order_dict, ensure_ascii=False, default=str),
                        int(time.time() * 1000),
                    ),
                )
        except Exception as e:
            logger.error(f"smart_order_store.save 失敗: {e}")

    def max_id_seq(self) -> int:
        """取所有歷史智慧單（含已觸發/取消）的最大流水號，供重啟後 id counter 續號。"""
        if not self.enabled:
            return 0
        try:
            with self._lock:
                conn = self._connect()
                rows = conn.execute("SELECT id FROM smart_orders").fetchall()
            max_seq = 0
            for (oid,) in rows:
                try:
                    max_seq = max(max_seq, int(str(oid).rsplit("_", 1)[-1]))
                except (ValueError, TypeError):
                    pass
            return max_seq
        except Exception as e:
            logger.error(f"smart_order_store.max_id_seq 失敗: {e}")
            return 0

    def load_active(self) -> list[dict]:
        """讀出所有仍 active 的智慧單（開機 re-arm 用）。"""
        if not self.enabled:
            return []
        try:
            with self._lock:
                conn = self._connect()
                rows = conn.execute(
                    "SELECT payload FROM smart_orders WHERE is_active = 1"
                ).fetchall()
            out = []
            for (payload,) in rows:
                try:
                    out.append(json.loads(payload))
                except Exception:
                    logger.warning("smart_order_store: 略過無法解析的 payload")
            return out
        except Exception as e:
            logger.error(f"smart_order_store.load_active 失敗: {e}")
            return []
