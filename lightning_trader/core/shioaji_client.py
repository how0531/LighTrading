import shioaji as sj
from shioaji.constant import StockPriceType, FuturesPriceType, OrderType, Action, QuoteType
from PyQt5.QtCore import QObject, pyqtSignal, QTimer
from .config import Config
import json
import logging

logger = logging.getLogger(__name__)

class ShioajiClient(QObject):
    """
    專業級 Shioaji 核心客戶端 - 完整報價與部位同步版
    """
    signal_quote_tick = pyqtSignal(object)       
    signal_quote_bidask = pyqtSignal(object)     
    signal_login_status = pyqtSignal(bool, str)  
    signal_order_update = pyqtSignal(object)     
    signal_trade_update = pyqtSignal(object)     
    signal_account_update = pyqtSignal(dict)     

    def __init__(self):
        super().__init__()
        self.is_simulation = Config.SIMULATION
        print(f"🚀 [Init] ShioajiClient 啟動. 初始環境 SIMULATION={self.is_simulation}")
        
        self.api = sj.Shioaji(simulation=self.is_simulation)
        self.current_contract = None
        self._is_connected = False
        self.active_stock_account = None
        self.active_futopt_account = None
        
        self._setup_callbacks()
        self.smart_orders = []
        self.volume_profile = {} 
        self.reconnect_timer = QTimer(self)
        self.reconnect_timer.timeout.connect(self.check_connection)
        self.reconnect_timer.start(10000) 
        
        if Config.API_KEY and Config.SECRET_KEY:
            QTimer.singleShot(100, self.login)

    def check_connection(self):
        if getattr(self, '_is_reconnecting', False): return
        if self._is_connected:
            try: self.api.list_accounts()
            except:
                self._is_connected = False
                self._attempt_reconnect()

    def _attempt_reconnect(self):
        self._is_reconnecting = True
        QTimer.singleShot(5000, self._do_login_reconnect)

    def _do_login_reconnect(self):
        if self.login(): self._is_reconnecting = False
        else: QTimer.singleShot(10000, self._do_login_reconnect)

    def _setup_callbacks(self):
        @self.api.on_tick_stk_v1()
        def on_tick_stk_v1(exchange: sj.Exchange, tick: sj.TickSTKv1):
            q_dict = {
                "Symbol": tick.code,
                "Price": float(tick.close), 
                "Volume": tick.volume, 
                "Open": float(tick.open), 
                "High": float(tick.high), 
                "Low": float(tick.low), 
                "AvgPrice": float(tick.avg_price), 
                "TickTime": tick.datetime.isoformat() if hasattr(tick.datetime, 'isoformat') else str(tick.datetime), 
                "Action": "Tick"
            }
            self.signal_quote_tick.emit(q_dict)

        @self.api.on_bidask_stk_v1()
        def on_bidask_stk_v1(exchange: sj.Exchange, bidask: sj.BidAskSTKv1):
            self.signal_quote_bidask.emit({
                "Symbol": bidask.code,
                "BidPrice": [float(p) for p in bidask.bid_price],
                "BidVolume": [int(v) for v in bidask.bid_volume],
                "AskPrice": [float(p) for p in bidask.ask_price],
                "AskVolume": [int(v) for v in bidask.ask_volume],
                "Time": bidask.datetime.isoformat() if hasattr(bidask, 'datetime', None) else str(bidask.datetime)
            })

        @self.api.on_bidask_fop_v1()
        def on_bidask_fop_v1(exchange: sj.Exchange, bidask: sj.BidAskFOPv1):
            self.signal_quote_bidask.emit({
                "Symbol": bidask.code,
                "BidPrice": [float(p) for p in bidask.bid_price],
                "BidVolume": [int(v) for v in bidask.bid_volume],
                "AskPrice": [float(p) for p in bidask.ask_price],
                "AskVolume": [int(v) for v in bidask.ask_volume],
                "Time": bidask.datetime.isoformat() if hasattr(bidask, 'datetime', None) else str(bidask.datetime)
            })
        
        def on_order_status(state, msg: dict):
            self.signal_order_update.emit(msg)
            QTimer.singleShot(500, self.trigger_account_update)

        self.api.set_order_callback(on_order_status)

    def login(self, api_key: str = None, secret_key: str = None, simulation: bool = None, ca_path: str = None, ca_passwd: str = None) -> bool:
        key = api_key or Config.API_KEY
        secret = secret_key or Config.SECRET_KEY
        target_simulation = simulation if simulation is not None else self.is_simulation
        if self.api is None or self.is_simulation != target_simulation:
            try: self.api.logout()
            except: pass
            self.is_simulation = target_simulation
            self.api = sj.Shioaji(simulation=self.is_simulation)
            self._setup_callbacks()
        try:
            self.api.login(api_key=key, secret_key=secret)
            if not self.is_simulation and (ca_path or Config.CA_PATH):
                self.api.activate_ca(ca_path=(ca_path or Config.CA_PATH).replace("\\", "/"), ca_passwd=(ca_passwd or Config.CA_PASSWD))
            accounts = self.api.list_accounts()
            self.active_stock_account = next((a for a in accounts if "Stock" in a.__class__.__name__), None)
            self.active_futopt_account = next((a for a in accounts if "Future" in a.__class__.__name__), None)
            self._is_connected = True
            self.signal_login_status.emit(True, "登入成功")
            QTimer.singleShot(1000, self.trigger_account_update)
            if self.current_contract: self.subscribe(self.current_contract.symbol)
            return True
        except Exception as e:
            self._is_connected = False
            self.signal_login_status.emit(False, f"登入失敗: {str(e)}")
            return False

    def set_active_account(self, full_account_id: str):
        target_id = str(full_account_id).split('-')[-1]
        accounts = self.api.list_accounts()
        for acc in accounts:
            if acc.account_id == target_id:
                if "Stock" in acc.__class__.__name__: self.active_stock_account = acc
                else: self.active_futopt_account = acc
                self.trigger_account_update()
                return True
        return False

    def list_positions(self):
        all_pos = []
        try:
            accounts = self.api.list_accounts()
            for acc in accounts:
                try:
                    self.api.update_status(acc)
                    positions = self.api.list_positions(acc)
                    for p in positions:
                        qty = int(p.quantity)
                        all_pos.append({
                            "symbol": str(p.code).strip().upper(),
                            "qty": qty, 
                            "direction": "Buy" if p.direction == Action.Buy else "Sell",
                            "price": float(p.price),
                            "pnl": float(p.pnl),
                            "account": f"{acc.broker_id}-{acc.account_id}"
                        })
                except: pass
            return all_pos
        except Exception as e:
            print(f"List positions crash: {e}")
            return []

    def trigger_account_update(self):
        try:
            positions = self.list_positions()
            data = {
                "is_simulation": self.is_simulation,
                "person_id": getattr(self.api, 'person_id', "N/A"),
                "active_stock": f"{self.active_stock_account.broker_id}-{self.active_stock_account.account_id}" if self.active_stock_account else "",
                "參考損益": sum(p["pnl"] for p in positions),
                "positions": positions
            }
            self.signal_account_update.emit(data)
        except Exception as e:
            print(f"Update error: {e}")

    def get_contract(self, symbol: str):
        if not symbol: return None
        symbol = str(symbol).strip().upper()
        return self.api.Contracts.Stocks.get(symbol) or self.api.Contracts.Futures.get(symbol) or self.api.Contracts.Options.get(symbol)

    def subscribe(self, symbol: str) -> str:
        contract = self.get_contract(symbol)
        if not contract: return ""
        if self.current_contract:
            try:
                self.api.quote.unsubscribe(self.current_contract, QuoteType.Tick)
                self.api.quote.unsubscribe(self.current_contract, QuoteType.BidAsk)
            except: pass
        self.current_contract = contract
        self.api.quote.subscribe(contract, QuoteType.Tick)
        self.api.quote.subscribe(contract, QuoteType.BidAsk)
        
        # 發送初始化 Snapshot 補齊 Reference, High, Low, LimitUp, LimitDown
        try:
            snaps = self.api.snapshots([contract])
            if snaps:
                s = snaps[0]
                self.signal_quote_tick.emit({
                    "Symbol": contract.symbol,
                    "Price": float(s.close),
                    "Volume": getattr(s, 'volume', 0),
                    "Open": float(getattr(s, 'open', s.close)),
                    "High": float(getattr(s, 'high', s.close)),
                    "Low": float(getattr(s, 'low', s.close)),
                    "Reference": float(getattr(s, 'reference', s.close)),
                    "LimitUp": float(getattr(contract, 'limit_up', s.close * 1.1)),
                    "LimitDown": float(getattr(contract, 'limit_down', s.close * 0.9)),
                    "TickTime": str(s.ts),
                    "Action": "Snapshot"
                })
        except: pass
        
        QTimer.singleShot(500, self.trigger_account_update)
        return contract.symbol

    def place_order(self, symbol: str, price: float, action: Action, qty: int, order_type: OrderType = OrderType.ROD, price_type=None):
        contract = self.get_contract(symbol)
        if not contract: return None
        account = self.active_stock_account if contract.security_type == 'STK' else self.active_futopt_account
        if not account: return None
        if price_type is None:
            price_type = (StockPriceType.LMT if price > 0 else StockPriceType.MKT) if contract.security_type == 'STK' else (FuturesPriceType.LMT if price > 0 else FuturesPriceType.MKT)
        order = self.api.Order(price=price if price > 0 else 0, quantity=qty, action=action, price_type=price_type, order_type=order_type, account=account)
        try: return self.api.place_order(contract, order)
        except: return None

    def get_all_accounts(self):
        try:
            raw_accounts = self.api.list_accounts()
            return [{"account_id": acc.account_id, "category": "Stock" if "Stock" in acc.__class__.__name__ else "Future" if "Future" in acc.__class__.__name__ else "Other", "person_id": acc.person_id, "broker_id": acc.broker_id, "account_name": f"{acc.broker_id}-{acc.account_id}"}]
        except: return []

    def get_account_balance(self):
        try:
            acc = self.active_stock_account or self.active_futopt_account
            if acc: return self.api.account_balance(acc)
            return None
        except: return None

    def get_order_history(self):
        try: return self.api.list_trades()
        except: return []
