"""
PositionTracker — 即時部位追蹤器

監聽 EventBus 的成交與行情事件，即時計算各商品的持倉與未實現損益。
不再依賴 HTTP polling，所有資料都從事件流驅動。
"""
import logging
from typing import Dict, Optional
from dataclasses import dataclass, field
from PyQt5.QtCore import QObject, QTimer

logger = logging.getLogger(__name__)


@dataclass
class PositionEntry:
    """單一商品的持倉記錄"""
    symbol: str
    net_qty: int = 0               # 正=多頭, 負=空頭
    avg_price: float = 0.0         # 平均成本
    unrealized_pnl: float = 0.0    # 未實現損益
    realized_pnl: float = 0.0     # 已實現損益(今日)
    last_price: float = 0.0        # 最新價格
    account_id: str = ""
    multiplier: float = 1.0        # 合約乘數 (期貨=50/200, 股票=1000)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "net_qty": self.net_qty,
            "direction": "Buy" if self.net_qty > 0 else "Sell" if self.net_qty < 0 else "Flat",
            "qty": abs(self.net_qty),
            "avg_price": round(self.avg_price, 2),
            "unrealized_pnl": round(self.unrealized_pnl, 2),
            "realized_pnl": round(self.realized_pnl, 2),
            "last_price": self.last_price,
            "account_id": self.account_id,
        }

    def update_mark_price(self, price: float):
        """更新最新價格並重新計算未實現損益"""
        self.last_price = price
        if self.net_qty != 0:
            self.unrealized_pnl = (price - self.avg_price) * self.net_qty * self.multiplier
        else:
            self.unrealized_pnl = 0.0


class PositionTracker(QObject):
    """
    即時部位追蹤器

    使用方式:
        pt = PositionTracker(event_bus)
        # EventBus 會自動驅動更新
        pos = pt.get_position("TXFD5")
        total_pnl = pt.total_unrealized_pnl
    """

    def __init__(self, event_bus):
        super().__init__()
        self.event_bus = event_bus
        self._positions: Dict[str, PositionEntry] = {}
        self._update_count = 0    # 變更計數器（供前端 dependency 用）

        # 連接事件
        self.event_bus.on_fill.connect(self._on_fill)
        self.event_bus.on_tick.connect(self._on_tick)
        self.event_bus.on_account_update.connect(self._on_account_sync)

        # 定期發射部位摘要（每 2 秒匯總一次，避免高頻事件淹沒 UI）
        self._emit_timer = QTimer(self)
        self._emit_timer.timeout.connect(self._emit_positions)
        self._emit_timer.start(2000)
        self._dirty = False

        logger.info("PositionTracker 已初始化")

    # ──── 事件處理 ────

    def _on_fill(self, fill_data: dict):
        """處理成交回報，更新部位"""
        symbol = fill_data.get("symbol", "").strip().upper()
        action = fill_data.get("action", "")
        fill_qty = int(fill_data.get("fill_qty", 0))
        fill_price = float(fill_data.get("fill_price", 0))

        if not symbol or fill_qty <= 0:
            return

        pos = self._get_or_create(symbol)

        # 計算方向性數量
        signed_qty = fill_qty if action == "Buy" else -fill_qty

        # 更新平均價格 (加權平均)
        old_qty = pos.net_qty
        new_qty = old_qty + signed_qty

        if new_qty == 0:
            # 全部平倉 → 計算已實現損益
            pos.realized_pnl += (fill_price - pos.avg_price) * (-old_qty) * pos.multiplier
            pos.avg_price = 0.0
        elif (old_qty >= 0 and new_qty > 0 and signed_qty > 0) or \
             (old_qty <= 0 and new_qty < 0 and signed_qty < 0):
            # 同方向加碼 → 更新加權平均價
            if old_qty != 0:
                pos.avg_price = (pos.avg_price * abs(old_qty) + fill_price * fill_qty) / abs(new_qty)
            else:
                pos.avg_price = fill_price
        elif abs(new_qty) < abs(old_qty):
            # 部分平倉 → 部分已實現損益
            close_qty = fill_qty
            pos.realized_pnl += (fill_price - pos.avg_price) * close_qty * (
                pos.multiplier if old_qty > 0 else -pos.multiplier
            )
        else:
            # 反向超越 → 先平倉再開新倉
            close_qty = abs(old_qty)
            open_qty = fill_qty - close_qty
            if close_qty > 0:
                pos.realized_pnl += (fill_price - pos.avg_price) * close_qty * (
                    pos.multiplier if old_qty > 0 else -pos.multiplier
                )
            pos.avg_price = fill_price

        pos.net_qty = new_qty
        pos.update_mark_price(fill_price)
        self._dirty = True
        self._update_count += 1

        logger.info(f"[PositionTracker] {symbol} 成交後部位: "
                    f"qty={new_qty}, avg={pos.avg_price:.2f}, "
                    f"unrealPnL={pos.unrealized_pnl:.0f}, realPnL={pos.realized_pnl:.0f}")

    def _on_tick(self, symbol: str, tick_data: dict):
        """每個 tick 更新最新價格和未實現損益"""
        if symbol in self._positions:
            price = tick_data.get("Price", 0)
            if price > 0:
                self._positions[symbol].update_mark_price(price)
                self._dirty = True

    def _on_account_sync(self, account_data: dict):
        """收到後端帳務同步時，合併部位資料"""
        positions = account_data.get("positions", [])
        for p in positions:
            symbol = str(p.get("symbol", "")).strip().upper()
            if not symbol:
                continue
            pos = self._get_or_create(symbol)
            # 以後端資料為基準同步
            direction = p.get("direction", "Buy")
            qty = int(p.get("qty", 0))
            pos.net_qty = qty if direction == "Buy" else -qty
            pos.avg_price = float(p.get("price", pos.avg_price))
            pos.account_id = p.get("account", "")
            if pos.last_price > 0:
                pos.update_mark_price(pos.last_price)
        self._dirty = True
        self._update_count += 1

    def _emit_positions(self):
        """定期發射部位匯總（降低 UI 更新頻率）"""
        if not self._dirty:
            return
        self._dirty = False
        self.event_bus.on_position_update.emit(self.get_all_positions_dict())

    # ──── 查詢介面 ────

    def _get_or_create(self, symbol: str) -> PositionEntry:
        if symbol not in self._positions:
            # 自動偵測合約乘數
            multiplier = self._detect_multiplier(symbol)
            self._positions[symbol] = PositionEntry(symbol=symbol, multiplier=multiplier)
        return self._positions[symbol]

    @staticmethod
    def _detect_multiplier(symbol: str) -> float:
        """根據商品代碼推斷合約乘數"""
        s = symbol.upper()
        if s.startswith("TX") or s.startswith("MTX"):
            return 200.0 if s.startswith("TX") else 50.0
        elif s.startswith("TE") or s.startswith("TF"):
            return 200.0
        elif any(s.startswith(p) for p in ["MX", "ZE", "ZF"]):
            return 50.0
        elif s.isdigit():
            # 股票：台股 1 張 = 1000 股 (但 position qty 通常已是張數)
            return 1000.0
        return 1.0

    def get_position(self, symbol: str) -> Optional[PositionEntry]:
        return self._positions.get(symbol.strip().upper())

    def get_all_positions(self) -> list:
        return [p for p in self._positions.values() if p.net_qty != 0]

    def get_all_positions_dict(self) -> dict:
        return {
            "positions": [p.to_dict() for p in self.get_all_positions()],
            "total_unrealized_pnl": self.total_unrealized_pnl,
            "total_realized_pnl": self.total_realized_pnl,
            "update_count": self._update_count,
        }

    @property
    def total_unrealized_pnl(self) -> float:
        return sum(p.unrealized_pnl for p in self._positions.values())

    @property
    def total_realized_pnl(self) -> float:
        return sum(p.realized_pnl for p in self._positions.values())

    @property
    def update_count(self) -> int:
        return self._update_count
