"""
WatchlistManager — 自選股管理器

管理多組自選股清單，支援即時行情訂閱、快速切換監控商品。
"""
import logging
import json
from typing import Dict, List, Optional
from dataclasses import dataclass, field
from pathlib import Path



logger = logging.getLogger(__name__)


@dataclass
class WatchlistItem:
    """自選股項目"""
    symbol: str
    name: str = ""
    last_price: float = 0.0
    change: float = 0.0
    change_pct: float = 0.0
    volume: int = 0
    is_subscribed: bool = False

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "name": self.name,
            "last_price": self.last_price,
            "change": self.change,
            "change_pct": round(self.change_pct, 2),
            "volume": self.volume,
            "is_subscribed": self.is_subscribed,
        }


@dataclass
class Watchlist:
    """自選股清單"""
    name: str
    items: List[WatchlistItem] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "items": [item.to_dict() for item in self.items],
        }


class WatchlistManager:
    """
    自選股管理器

    使用方式:
        wm = WatchlistManager(event_bus)
        wm.add_symbol("default", "TXFD5", "台指06")
        wm.add_symbol("default", "2330", "台積電")
        items = wm.get_watchlist("default")
    """

    DEFAULT_WATCHLISTS = {
        "default": [
            {"symbol": "TXFD5", "name": "台指近月"},
            {"symbol": "MXFD5", "name": "小台近月"},
        ],
        "stocks": [
            {"symbol": "2330", "name": "台積電"},
            {"symbol": "2317", "name": "鴻海"},
            {"symbol": "2454", "name": "聯發科"},
        ],
    }

    def __init__(self, event_bus):
        self.event_bus = event_bus
        self._watchlists: Dict[str, Watchlist] = {}
        self._active_list: str = "default"
        self._active_index: int = 0

        # 監聽 tick 更新自選股報價
        self.event_bus.on_tick.connect(self._on_tick)

        # 載入或初始化
        self._load()
        logger.info(f"WatchlistManager 已初始化, {len(self._watchlists)} 組清單")

    def _load(self):
        """從 QSettings 載入，沒有則用預設"""
        settings = QSettings("LighTrading", "Watchlist")
        saved = settings.value("watchlists", None)
        if saved:
            try:
                data = json.loads(saved) if isinstance(saved, str) else saved
                for name, items in data.items():
                    wl = Watchlist(name=name)
                    for item in items:
                        wl.items.append(WatchlistItem(
                            symbol=item["symbol"],
                            name=item.get("name", ""),
                        ))
                    self._watchlists[name] = wl
            except Exception as e:
                logger.warning(f"載入自選股失敗, 使用預設值: {e}")
                self._load_defaults()
        else:
            self._load_defaults()

    def _load_defaults(self):
        for name, items in self.DEFAULT_WATCHLISTS.items():
            wl = Watchlist(name=name)
            for item in items:
                wl.items.append(WatchlistItem(
                    symbol=item["symbol"], name=item.get("name", "")
                ))
            self._watchlists[name] = wl

    def save(self):
        """儲存到 QSettings"""
        settings = QSettings("LighTrading", "Watchlist")
        data = {}
        for name, wl in self._watchlists.items():
            data[name] = [{"symbol": i.symbol, "name": i.name} for i in wl.items]
        settings.setValue("watchlists", json.dumps(data, ensure_ascii=False))
        logger.info("自選股已儲存")

    # ──── Tick 更新 ────

    def _on_tick(self, symbol: str, tick_data: dict):
        """更新自選股中對應商品的報價"""
        for wl in self._watchlists.values():
            for item in wl.items:
                if item.symbol == symbol:
                    ref_price = tick_data.get("Reference", item.last_price)
                    item.last_price = tick_data.get("Price", item.last_price)
                    item.volume = tick_data.get("Volume", item.volume)
                    if ref_price and ref_price > 0:
                        item.change = item.last_price - ref_price
                        item.change_pct = item.change / ref_price * 100

    # ──── CRUD ────

    def add_symbol(self, list_name: str, symbol: str, name: str = "") -> bool:
        """新增商品到指定清單"""
        if list_name not in self._watchlists:
            self._watchlists[list_name] = Watchlist(name=list_name)

        wl = self._watchlists[list_name]
        # 檢查重複
        if any(i.symbol == symbol for i in wl.items):
            return False

        wl.items.append(WatchlistItem(symbol=symbol, name=name))
        self.save()
        logger.info(f"[Watchlist] 新增 {symbol} 到 [{list_name}]")
        return True

    def remove_symbol(self, list_name: str, symbol: str) -> bool:
        """從指定清單移除商品"""
        wl = self._watchlists.get(list_name)
        if not wl:
            return False
        wl.items = [i for i in wl.items if i.symbol != symbol]
        self.save()
        return True

    def create_watchlist(self, name: str) -> bool:
        if name in self._watchlists:
            return False
        self._watchlists[name] = Watchlist(name=name)
        self.save()
        return True

    def delete_watchlist(self, name: str) -> bool:
        if name == "default" or name not in self._watchlists:
            return False
        del self._watchlists[name]
        if self._active_list == name:
            self._active_list = "default"
        self.save()
        return True

    # ──── 快速切換 ────

    def switch_next(self) -> Optional[str]:
        """切換到下一個自選股 (Tab 鍵)"""
        wl = self._watchlists.get(self._active_list)
        if not wl or not wl.items:
            return None
        self._active_index = (self._active_index + 1) % len(wl.items)
        symbol = wl.items[self._active_index].symbol
        self.event_bus.on_symbol_changed.emit(symbol)
        logger.info(f"[Watchlist] 切換商品: {symbol}")
        return symbol

    def get_current_symbol(self) -> Optional[str]:
        wl = self._watchlists.get(self._active_list)
        if wl and wl.items and self._active_index < len(wl.items):
            return wl.items[self._active_index].symbol
        return None

    # ──── 查詢 ────

    def get_watchlist(self, name: str = "default") -> Optional[dict]:
        wl = self._watchlists.get(name)
        return wl.to_dict() if wl else None

    def get_all_watchlists(self) -> List[dict]:
        return [wl.to_dict() for wl in self._watchlists.values()]

    def get_all_symbols(self) -> List[str]:
        """取得所有自選股的不重複商品代碼"""
        symbols = set()
        for wl in self._watchlists.values():
            for item in wl.items:
                symbols.add(item.symbol)
        return list(symbols)
