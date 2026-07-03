"""
LighTrading Core Package

統一匯出所有核心模組，提供簡潔的 import 介面。

Usage:
    from core import create_trading_engine
    engine = create_trading_engine()
    # engine.event_bus, engine.client, engine.risk_manager, ...
"""
from .event_bus import EventBus
from .config import Config
from .symbol_resolver import SymbolResolver
from .shioaji_client import ShioajiClient
from .smart_order_engine import SmartOrderEngine, SmartOrderType
from .smart_order_store import SmartOrderStore, default_db_path
from .risk_manager import RiskManager, RiskConfig, CheckResult, CheckLevel

__all__ = [
    # 核心
    "EventBus", "Config", "ShioajiClient", "SymbolResolver",
    # 交易引擎
    "SmartOrderEngine", "SmartOrderType", "SmartOrderStore",
    # 風控
    "RiskManager", "RiskConfig", "CheckResult", "CheckLevel",
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

        # 3. 風控引擎 (下單前檢查 + 日虧損監控)
        self.risk_manager = RiskManager(self.event_bus)

        # 4. 智慧委託 (觸價/移停/OCO/Bracket)，含 SQLite 持久化 + 開機 re-arm
        self.smart_order_engine = SmartOrderEngine(
            self.event_bus,
            place_order_fn=self._place_order_via_client,
            store=SmartOrderStore(default_db_path()),
        )

    def _place_order_via_client(self, symbol, price, action, qty):
        """SmartOrderEngine 預設下單函數（backend 會改注入有風控的版本）"""
        from shioaji.constant import Action
        action_enum = action if isinstance(action, Action) else (
            Action.Buy if str(action).lower() == "buy" else Action.Sell
        )
        return self.client.place_order(symbol, price, action_enum, qty)


def create_trading_engine() -> TradingEngine:
    """工廠函數 — 建立完整的交易引擎"""
    return TradingEngine()
