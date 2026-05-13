"""
symbol_resolver.py — 統一的商品代號正規化

解決 Shioaji 兩種代號並存的問題：
  - contract.symbol：使用者面向（例如 "TXFR1" 滾動連續月，"2330"）
  - contract.code  ：實際合約月份（例如 "TXFE5"）

報價回呼帶回的是 tick.code（也就是 contract.code），但前端訂閱與 PnL 計算用的
是 user-facing 的 symbol。沒有這層 mapping，期貨報價會被丟到對不上的 key，
造成 PnL 拿不到最新價、退回 broker 靜態 pnl 不會動。

使用方式：
    resolver = SymbolResolver()
    resolver.register(contract)
    canonical = resolver.canonical(tick.code)   # 拿到 user-facing symbol
"""
import threading
from typing import Optional


class SymbolResolver:
    """執行緒安全的雙向 alias 表"""

    def __init__(self):
        self._alias: dict[str, str] = {}
        self._lock = threading.Lock()

    def register(self, contract) -> None:
        """登記一個合約。傳入 Shioaji contract 物件即可。"""
        if contract is None:
            return
        sym = str(getattr(contract, "symbol", "") or "").strip().upper()
        code = str(getattr(contract, "code", "") or "").strip().upper()
        if not sym and not code:
            return
        with self._lock:
            if sym:
                self._alias[sym] = sym
            if code:
                self._alias[code] = sym or code

    def register_pair(self, code: str, symbol: str) -> None:
        """直接登記一組 code → symbol 別名（測試或手動補強用）。"""
        if not code:
            return
        with self._lock:
            self._alias[str(code).strip().upper()] = str(symbol).strip().upper()

    def canonical(self, raw: Optional[str]) -> str:
        """把任何 code 或 symbol 轉成 user-facing 的 canonical symbol。"""
        if not raw:
            return ""
        key = str(raw).strip().upper()
        with self._lock:
            return self._alias.get(key, key)

    def all_known(self) -> list[str]:
        with self._lock:
            return sorted(set(self._alias.values()))
