"""
fake_shioaji.py — 測試用的 shioaji SDK 替身

在 import backend.main / core 之前先呼叫 install()，把 `shioaji` 與
`shioaji.constant` 塞進 sys.modules。之後 ShioajiClient 會包著這個假 SDK 跑，
讓整合測試能在沒有券商連線 / 沒有真 shioaji wheel 的環境下，
走完「真的」client 程式碼路徑（place_order / flatten / reverse / subscribe）。
"""
from __future__ import annotations
import sys
import types
from enum import Enum
from types import SimpleNamespace


# ─── constants（shioaji.constant） ──────────────────────────

class Action(str, Enum):
    Buy = "Buy"
    Sell = "Sell"


class OrderType(str, Enum):
    ROD = "ROD"
    IOC = "IOC"
    FOK = "FOK"


class StockPriceType(str, Enum):
    LMT = "LMT"
    MKT = "MKT"
    MKP = "MKP"


class FuturesPriceType(str, Enum):
    LMT = "LMT"
    MKT = "MKT"
    MKP = "MKP"


class QuoteType(str, Enum):
    Tick = "tick"
    BidAsk = "bidask"


class StockOrderLot(str, Enum):
    Common = "Common"
    Odd = "Odd"
    IntradayOdd = "IntradayOdd"
    Fixing = "Fixing"


class StockOrderCond(str, Enum):
    Cash = "Cash"
    MarginTrading = "MarginTrading"
    ShortSelling = "ShortSelling"


# ─── 合約 / 帳號 / 部位 ─────────────────────────────────────

class FakeContract(SimpleNamespace):
    pass


def make_stock_contract(code: str, name: str = "測試股",
                        symbol: str | None = None) -> FakeContract:
    """symbol 預設等於 code；傳入不同值可模擬 TSE 前綴（如 TSE2330）"""
    return FakeContract(
        symbol=symbol or code, code=code, name=name,
        security_type="STK", limit_up=0.0, limit_down=0.0,
    )


class FakeStockAccount(SimpleNamespace):
    def __init__(self):
        super().__init__(account_id="1234567", broker_id="9A00",
                         person_id="A123456789", account_type="S")


class FakeFutureAccount(SimpleNamespace):
    def __init__(self):
        super().__init__(account_id="7654321", broker_id="F002",
                         person_id="A123456789", account_type="F")


# 讓 "Stock"/"Future" in acc.__class__.__name__ 的判斷成立
FakeStockAccount.__name__ = "StockAccount"
FakeFutureAccount.__name__ = "FutureAccount"


class FakePosition(SimpleNamespace):
    """shioaji list_positions 回傳的部位物件"""
    def __init__(self, code: str, quantity: int, direction: Action,
                 price: float = 100.0, pnl: float = 0.0):
        super().__init__(code=code, quantity=quantity, direction=direction,
                         price=price, pnl=pnl)


def make_trade(code: str, action: Action, price: float, qty: int,
               status: str = "Submitted", ordno: str = "",
               deals: list | None = None, filled_qty: int = 0):
    """組一個 list_trades() 回傳的 trade 物件（測試外部管道委託/成交用）。

    deals: [(price, qty, seq, ts_sec), ...]
    """
    deal_objs = [
        SimpleNamespace(price=p, quantity=q, seq=seq, ts=ts)
        for (p, q, seq, ts) in (deals or [])
    ]
    return SimpleNamespace(
        contract=make_stock_contract(code),
        order=SimpleNamespace(
            id=ordno or f"EXT-{code}", seqno=ordno or f"EXT-{code}",
            ordno=ordno or f"EXT-{code}",
            action=action, price=price, quantity=qty,
            account=SimpleNamespace(account_id="1234567"),
        ),
        status=SimpleNamespace(
            status=SimpleNamespace(name=status),
            deal_quantity=filled_qty,
            deals=deal_objs,
            modified_at=None,
        ),
    )


# ─── Contracts 樹 ───────────────────────────────────────────

class _StocksNode:
    def __init__(self):
        self._by_code: dict[str, FakeContract] = {}

    def add(self, contract: FakeContract):
        self._by_code[contract.code] = contract

    def get(self, symbol: str):
        return self._by_code.get(symbol)

    def __iter__(self):
        return iter(self._by_code.values())


class _EmptyCategoryNode:
    """Futures / Options — 測試只用股票，給空樹即可"""
    def __iter__(self):
        return iter(())


# ─── 假 Shioaji API 本體 ────────────────────────────────────

class FakeQuote:
    def __init__(self):
        self.subscribed: list[tuple] = []
        self.unsubscribed: list[tuple] = []

    def set_on_tick_stk_v1_callback(self, fn): self.on_tick_stk = fn
    def set_on_bidask_stk_v1_callback(self, fn): self.on_bidask_stk = fn
    def set_on_tick_fop_v1_callback(self, fn): self.on_tick_fop = fn
    def set_on_bidask_fop_v1_callback(self, fn): self.on_bidask_fop = fn
    def set_quote_callback(self, fn): self.on_quote = fn

    def subscribe(self, contract, quote_type):
        self.subscribed.append((getattr(contract, "code", "?"), str(quote_type)))

    def unsubscribe(self, contract, quote_type):
        self.unsubscribed.append((getattr(contract, "code", "?"), str(quote_type)))


class FakeShioaji:
    """替身 SDK。測試可讀 .placed_orders 驗證實際送單參數。"""

    def __init__(self, simulation: bool = True):
        self.simulation = simulation
        self.quote = FakeQuote()
        self.person_id = "A123456789"
        self._accounts = [FakeStockAccount(), FakeFutureAccount()]
        self.Contracts = SimpleNamespace(
            Stocks=_StocksNode(),
            Futures=_EmptyCategoryNode(),
            Options=_EmptyCategoryNode(),
        )
        # 預設放幾檔測試股票（1101 模擬 symbol 帶 TSE 前綴、與 code 不同的情境）
        self.Contracts.Stocks.add(make_stock_contract("2330", "台積電"))
        self.Contracts.Stocks.add(make_stock_contract("2890", "永豐金"))
        self.Contracts.Stocks.add(make_stock_contract("1101", "台泥", symbol="TSE1101"))

        self.placed_orders: list[dict] = []
        self.positions: list[FakePosition] = []   # 測試自行注入
        self.trades: list = []                     # 測試自行注入（make_trade）
        self._order_seq = 0
        self._order_callback = None

    # ── session ──
    def login(self, api_key: str = "", secret_key: str = "", **kw):
        return self._accounts

    def logout(self):
        pass

    def activate_ca(self, **kw):
        return True

    def list_accounts(self):
        return self._accounts

    # ── callbacks ──
    def set_order_callback(self, fn):
        self._order_callback = fn

    # ── 下單 ──
    def Order(self, **kwargs):
        return SimpleNamespace(**kwargs)

    def place_order(self, contract, order):
        self._order_seq += 1
        record = {
            "code": getattr(contract, "code", ""),
            "action": str(getattr(order, "action", "")),
            "price": getattr(order, "price", None),
            "qty": getattr(order, "quantity", None),
            "order_type": str(getattr(order, "order_type", "")),
            "price_type": str(getattr(order, "price_type", "")),
            "order_lot": str(getattr(order, "order_lot", "")),
            "order_cond": str(getattr(order, "order_cond", "")),
        }
        self.placed_orders.append(record)
        return SimpleNamespace(
            order=SimpleNamespace(id=f"ORD{self._order_seq:04d}", seqno=f"{self._order_seq:06d}",
                                  action=getattr(order, "action", None),
                                  price=getattr(order, "price", 0),
                                  quantity=getattr(order, "quantity", 0)),
            status=SimpleNamespace(status=SimpleNamespace(name="Submitted")),
            contract=contract,
        )

    # ── 查詢 ──
    def update_status(self, *args, **kwargs):
        pass

    def list_positions(self, acc=None):
        # 只有股票帳號回傳部位，避免 client 迭代兩個帳號時重複計算
        if acc is None or getattr(acc, "account_type", "S") == "S":
            return list(self.positions)
        return []

    def list_trades(self):
        return list(self.trades)

    def snapshots(self, contracts):
        return []

    def account_balance(self, acc=None):
        return SimpleNamespace(equity=1_000_000, margin_available=500_000,
                               margin_required=0, pnl=0)

    def kbars(self, contract, start=None, end=None):
        return SimpleNamespace(ts=[], Open=[], High=[], Low=[], Close=[], Volume=[])


def install() -> types.ModuleType:
    """把假 shioaji 塞進 sys.modules（重複呼叫安全）。回傳 shioaji 模組。"""
    if "shioaji" in sys.modules and getattr(sys.modules["shioaji"], "__fake__", False):
        return sys.modules["shioaji"]

    sj = types.ModuleType("shioaji")
    sj.__fake__ = True
    sj.Shioaji = FakeShioaji

    const = types.ModuleType("shioaji.constant")
    const.Action = Action
    const.OrderType = OrderType
    const.StockPriceType = StockPriceType
    const.FuturesPriceType = FuturesPriceType
    const.QuoteType = QuoteType
    const.StockOrderLot = StockOrderLot
    const.StockOrderCond = StockOrderCond

    sj.constant = const
    sys.modules["shioaji"] = sj
    sys.modules["shioaji.constant"] = const
    return sj
