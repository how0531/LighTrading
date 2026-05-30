"""
vwap_calculator.py — 每商品 Volume-Weighted Average Price 計算器

當沖最常用的單一指標：揭示「目前價格相對於成交均價偏離多少」，
通常用於判斷強弱多空（價在 VWAP 上 = 強勢）。

設計：
  - 訂閱 event_bus.on_tick；每筆 tick 累加 (price * volume) 與 volume
  - per-symbol 獨立計算
  - reset_session 由 main.py 的每日 04:00 Asia/Taipei task 呼叫
  - 執行緒安全（broker callback thread 寫入、FastAPI thread 讀取）
"""
import logging
import threading
from dataclasses import dataclass
from typing import Dict, Optional

logger = logging.getLogger(__name__)


@dataclass
class VWAPSnapshot:
    symbol: str
    vwap: float
    total_volume: int
    tick_count: int


class VWAPCalculator:
    def __init__(self, event_bus):
        self.event_bus = event_bus
        self._lock = threading.RLock()
        self._sum_pv: Dict[str, float] = {}
        self._sum_v: Dict[str, int] = {}
        self._tick_count: Dict[str, int] = {}

        self.event_bus.on_tick.connect(self._on_tick)
        logger.info("VWAPCalculator 已初始化")

    def _on_tick(self, symbol: str, tick_data: dict):
        price = tick_data.get("Price", 0)
        volume = tick_data.get("Volume", 0)
        if price <= 0 or volume <= 0:
            return
        with self._lock:
            self._sum_pv[symbol] = self._sum_pv.get(symbol, 0.0) + price * volume
            self._sum_v[symbol] = self._sum_v.get(symbol, 0) + volume
            self._tick_count[symbol] = self._tick_count.get(symbol, 0) + 1

    def get(self, symbol: str) -> Optional[VWAPSnapshot]:
        sym = symbol.strip().upper()
        with self._lock:
            v = self._sum_v.get(sym, 0)
            if v == 0:
                return None
            return VWAPSnapshot(
                symbol=sym,
                vwap=self._sum_pv[sym] / v,
                total_volume=v,
                tick_count=self._tick_count.get(sym, 0),
            )

    def get_all(self) -> Dict[str, VWAPSnapshot]:
        with self._lock:
            return {
                sym: VWAPSnapshot(
                    symbol=sym,
                    vwap=self._sum_pv[sym] / v,
                    total_volume=v,
                    tick_count=self._tick_count.get(sym, 0),
                )
                for sym, v in self._sum_v.items() if v > 0
            }

    def reset_session(self, symbol: Optional[str] = None) -> None:
        """每日盤前重置；不傳 symbol 則重置全部。"""
        with self._lock:
            if symbol is None:
                self._sum_pv.clear()
                self._sum_v.clear()
                self._tick_count.clear()
                logger.info("[VWAP] 全商品 session 已重置")
            else:
                sym = symbol.strip().upper()
                self._sum_pv.pop(sym, None)
                self._sum_v.pop(sym, None)
                self._tick_count.pop(sym, None)
                logger.info(f"[VWAP] {sym} session 已重置")
