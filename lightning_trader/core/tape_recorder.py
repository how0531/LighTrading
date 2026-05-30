"""
tape_recorder.py — 成交明細跑馬燈 (Time & Sales)

期貨 scalper 盯著吃單／吐單做盤感，這是不可缺少的「第二隻眼」。
本模組維護 per-symbol 最近 N 筆 tick，並標記內外盤。

設計：
  - 訂閱 event_bus.on_tick
  - 每商品 deque(maxlen=DEFAULT_LIMIT)，O(1) append / 切片快
  - tick_type 1 = 外盤（買方主動成交），2 = 內盤（賣方主動成交），0 = 集合競價
  - 提供 get(symbol, limit) 給 router；前端開 panel 時拉一次當初始值，
    後續再從 WS 的 Tick 事件自己 append（避免重複推播壓力）
"""
import logging
import threading
from collections import deque
from typing import Dict, List, Deque

logger = logging.getLogger(__name__)

DEFAULT_LIMIT = 500   # 每商品保留最近 N 筆


class TapeRecorder:
    def __init__(self, event_bus, maxlen: int = DEFAULT_LIMIT):
        self.event_bus = event_bus
        self._maxlen = maxlen
        self._lock = threading.RLock()
        self._tape: Dict[str, Deque[dict]] = {}

        self.event_bus.on_tick.connect(self._on_tick)
        logger.info(f"TapeRecorder 已初始化 (maxlen={maxlen}/symbol)")

    def _on_tick(self, symbol: str, tick_data: dict):
        price = tick_data.get("Price", 0)
        volume = tick_data.get("Volume", 0)
        if price <= 0 or volume <= 0:
            return
        entry = {
            "time": tick_data.get("TickTime", ""),
            "price": price,
            "volume": volume,
            "tick_type": tick_data.get("TickType", 0),  # 1=外盤 2=內盤
        }
        with self._lock:
            if symbol not in self._tape:
                self._tape[symbol] = deque(maxlen=self._maxlen)
            self._tape[symbol].append(entry)

    def get(self, symbol: str, limit: int = 100) -> List[dict]:
        """取最近 N 筆成交，新的在後面。"""
        sym = symbol.strip().upper()
        with self._lock:
            buf = self._tape.get(sym)
            if not buf:
                return []
            if limit >= len(buf):
                return list(buf)
            return list(buf)[-limit:]

    def clear(self, symbol: str = None) -> None:
        with self._lock:
            if symbol is None:
                self._tape.clear()
            else:
                self._tape.pop(symbol.strip().upper(), None)
