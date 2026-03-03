"""
LighTrading Core Package

統一匯出所有核心模組，提供簡潔的 import 介面。

Usage:
    from core import create_trading_engine
    engine = create_trading_engine()
    # engine.event_bus, engine.client, engine.order_manager, ...
"""
from .event_bus import EventBus
from .config import Config
from .shioaji_client import ShioajiClient
from .order_manager import OrderManager, OrderEntry, OrderStatus
from .position_tracker import PositionTracker, PositionEntry
from .smart_order_engine import SmartOrderEngine, SmartOrderType
from .risk_manager import RiskManager, RiskConfig, CheckResult, CheckLevel
from .hotkey_manager import HotkeyManager
from .watchlist_manager import WatchlistManager
from .sound_manager import SoundManager

__all__ = [
    # 核心
    "EventBus", "Config", "ShioajiClient",
    # 交易引擎
    "OrderManager", "OrderEntry", "OrderStatus",
    "PositionTracker", "PositionEntry",
    "SmartOrderEngine", "SmartOrderType",
    # 風控
    "RiskManager", "RiskConfig", "CheckResult", "CheckLevel",
    # 工具
    "HotkeyManager", "WatchlistManager", "SoundManager",
    # 工廠
    "create_trading_engine",
]


class TradingEngine:
    """
    交易引擎 — 統一持有所有核心模組實例

    所有模組透過 EventBus 通訊，此 class 僅負責建立和持有引用。
    外部可透過 engine.xxx 存取任何模組。
    """
    def __init__(self):
        # 1. 事件匯流排 (所有模組的通訊骨幹)
        self.event_bus = EventBus()

        # 2. Shioaji 客戶端 (券商通訊)
        self.client = ShioajiClient(event_bus=self.event_bus)

        # 3. 訂單管理 (本地訂單簿)
        self.order_manager = OrderManager(self.event_bus)

        # 4. 部位追蹤 (即時 PnL)
        self.position_tracker = PositionTracker(self.event_bus)

        # 5. 風控引擎 (下單前檢查 + 日虧損監控)
        self.risk_manager = RiskManager(self.event_bus)

        # 6. 智慧委託 (觸價/移停/OCO/Bracket)
        self.smart_order_engine = SmartOrderEngine(
            self.event_bus,
            place_order_fn=self._place_order_via_client,
        )

        # 7. 快捷鍵管理
        self.hotkey_manager = HotkeyManager(self.event_bus)

        # 8. 自選股管理
        self.watchlist_manager = WatchlistManager(self.event_bus)

        # 9. 音效管理
        self.sound_manager = SoundManager(self.event_bus)

        # 連接 Shioaji order callback → OrderManager
        self.client.signal_order_update.connect(
            lambda msg: self.order_manager.on_order_status_callback(None, msg)
        )

    def _place_order_via_client(self, symbol, price, action, qty):
        """SmartOrderEngine 呼叫的下單函數"""
        return self.client.place_order(symbol, price, action, qty)


def create_trading_engine() -> TradingEngine:
    """工廠函數 — 建立完整的交易引擎"""
    return TradingEngine()
