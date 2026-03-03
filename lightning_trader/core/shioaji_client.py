import shioaji as sj
from shioaji.constant import StockPriceType, FuturesPriceType, OrderType, Action, QuoteType
from PyQt5.QtCore import QObject, pyqtSignal, QTimer
from .config import Config
import json
import logging
from typing import Optional, List, Dict, Any

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

    def __init__(self, event_bus=None):
        super().__init__()
        self.event_bus = event_bus
        self.is_simulation = Config.SIMULATION
        logger.info(f"🚀 [Init] ShioajiClient 啟動. 初始環境 SIMULATION={self.is_simulation}")
        
        self.api = sj.Shioaji(simulation=self.is_simulation)
        self.current_contract = None
        self._is_connected = False
        self.active_stock_account = None
        self.active_futopt_account = None
        # 直接回呼 (繞過 Qt signal，解決 uvicorn 跨執行緒問題)
        self._direct_quote_callback = None
        
        self._setup_callbacks()
        self.smart_orders: List[Dict[str, Any]] = []
        self.volume_profile: Dict[str, Any] = {} 
        self.reconnect_timer = QTimer(self)
        self.reconnect_timer.timeout.connect(self.check_connection)
        self.reconnect_timer.start(10000) 
        
        # 注意：自動登入已移至 main.py lifespan，避免雙重登入競態
        # 如果需要從 PyQt5 GUI 使用，可在 GUI 中手動呼叫 login()

    def check_connection(self):
        if getattr(self, '_is_reconnecting', False): return
        if self._is_connected:
            try:
                self.api.list_accounts()
            except Exception as e:
                logger.warning(f"連線檢查失敗，準備重連: {e}")
                self._is_connected = False
                self._attempt_reconnect()

    def _attempt_reconnect(self):
        self._is_reconnecting = True
        QTimer.singleShot(5000, self._do_login_reconnect)

    def _do_login_reconnect(self):
        if self.login():
            logger.info("重連成功")
            self._is_reconnecting = False
        else:
            logger.warning("重連失敗，10 秒後重試")
            QTimer.singleShot(10000, self._do_login_reconnect)

    def _setup_callbacks(self):
        # === Shioaji v1 回呼（新版 SDK 預設格式） ===
        # TickSTKv1 / BidAskSTKv1 → 統一 dict → _direct_quote_callback → asyncio Queue → WebSocket

        def _on_tick_stk(exchange, tick):
            """股票 Tick 回呼"""
            try:
                symbol = self.current_contract.symbol if self.current_contract else str(tick.code)
                q = {
                    "Symbol": symbol,
                    "Price": float(tick.close),
                    "Volume": int(tick.volume),
                    "Open": float(tick.open),
                    "High": float(tick.high),
                    "Low": float(tick.low),
                    "AvgPrice": float(tick.avg_price),
                    "TickType": int(tick.tick_type),
                    "TickTime": str(tick.datetime),
                }
                if q["Price"] > 0 and self._direct_quote_callback:
                    self._direct_quote_callback(q)
            except Exception as e:
                logger.error(f"_on_tick_stk 錯誤: {e}")

        def _on_bidask_stk(exchange, bidask):
            """股票 BidAsk 回呼"""
            try:
                symbol = self.current_contract.symbol if self.current_contract else str(bidask.code)
                bp = [float(p) for p in bidask.bid_price]
                bv = [int(v) for v in bidask.bid_volume]
                ap = [float(p) for p in bidask.ask_price]
                av = [int(v) for v in bidask.ask_volume]
                q = {
                    "Symbol": symbol,
                    "AskPrice": ap, "AskVolume": av,
                    "BidPrice": bp, "BidVolume": bv,
                    "DiffBidVol": [int(v) for v in bidask.diff_bid_vol],
                    "DiffAskVol": [int(v) for v in bidask.diff_ask_vol],
                    "Time": str(bidask.datetime),
                }
                if self._direct_quote_callback:
                    self._direct_quote_callback(q)
            except Exception as e:
                logger.error(f"_on_bidask_stk 錯誤: {e}")

        def _on_tick_fop(exchange, tick):
            """期貨/選擇權 Tick 回呼"""
            try:
                symbol = self.current_contract.symbol if self.current_contract else str(tick.code)
                q = {
                    "Symbol": symbol,
                    "Price": float(tick.close),
                    "Volume": int(tick.volume),
                    "Open": float(tick.open),
                    "High": float(tick.high),
                    "Low": float(tick.low),
                    "AvgPrice": float(tick.avg_price),
                    "TickType": int(tick.tick_type),
                    "TickTime": str(tick.datetime),
                }
                if q["Price"] > 0 and self._direct_quote_callback:
                    self._direct_quote_callback(q)
            except Exception as e:
                logger.error(f"_on_tick_fop 錯誤: {e}")

        def _on_bidask_fop(exchange, bidask):
            """期貨/選擇權 BidAsk 回呼"""
            try:
                symbol = self.current_contract.symbol if self.current_contract else str(bidask.code)
                bp = [float(p) for p in bidask.bid_price]
                bv = [int(v) for v in bidask.bid_volume]
                ap = [float(p) for p in bidask.ask_price]
                av = [int(v) for v in bidask.ask_volume]
                q = {
                    "Symbol": symbol,
                    "AskPrice": ap, "AskVolume": av,
                    "BidPrice": bp, "BidVolume": bv,
                    "DiffBidVol": [int(v) for v in bidask.diff_bid_vol],
                    "DiffAskVol": [int(v) for v in bidask.diff_ask_vol],
                    "Time": str(bidask.datetime),
                }
                if self._direct_quote_callback:
                    self._direct_quote_callback(q)
            except Exception as e:
                logger.error(f"_on_bidask_fop 錯誤: {e}")

        # 註冊 v1 回呼（股票 + 期貨/選擇權）
        self.api.quote.set_on_tick_stk_v1_callback(_on_tick_stk)
        self.api.quote.set_on_bidask_stk_v1_callback(_on_bidask_stk)
        self.api.quote.set_on_tick_fop_v1_callback(_on_tick_fop)
        self.api.quote.set_on_bidask_fop_v1_callback(_on_bidask_fop)
        logger.info("✅ 已註冊 v1 報價回呼 (STK + FOP Tick/BidAsk)")

        def on_order_status(state, msg: dict):
            self.signal_order_update.emit(msg)
            QTimer.singleShot(500, self.trigger_account_update)

        self.api.set_order_callback(on_order_status)

    def login(self, api_key: str = None, secret_key: str = None, simulation: bool = None, ca_path: str = None, ca_passwd: str = None) -> bool:
        key = api_key or Config.API_KEY
        secret = secret_key or Config.SECRET_KEY
        target_simulation = simulation if simulation is not None else self.is_simulation
        if self.api is None or self.is_simulation != target_simulation:
            try:
                self.api.logout()
            except Exception as e:
                logger.debug(f"登出舊連線時發生例外（可忽略）: {e}")
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
            # ★ 關鍵：login 後強制重新註冊回呼，確保 set_quote_callback 在已登入狀態下生效
            self._setup_callbacks()
            logger.info("✅ Shioaji 登入成功，回呼已重新註冊")
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

    def list_positions(self) -> List[Dict[str, Any]]:
        all_pos = []
        try:
            accounts = self.api.list_accounts()
            # 過濾掉不支援 list_positions 的帳號類型 (H=海外期貨)
            UNSUPPORTED_TYPES = {'H'}
            for acc in accounts:
                acc_type = getattr(acc, 'account_type', None) or getattr(acc, 'category', '')
                if str(acc_type).upper() in UNSUPPORTED_TYPES:
                    continue
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
                except Exception as e:
                    logger.warning(f"查詢帳號 {acc.account_id} 持倉失敗: {e}")
            return all_pos
        except Exception as e:
            logger.error(f"list_positions 總體錯誤: {e}")
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
            logger.error(f"trigger_account_update 錯誤: {e}")

    def get_contract(self, symbol: str):
        if not symbol: return None
        symbol = str(symbol).strip().upper()
        # 1. 嘗試直接取得 (主要針對股票 Stocks 或某些能直接對應的合約)
        contract = self.api.Contracts.Stocks.get(symbol)
        if contract: return contract

        # 2. 深度搜尋期貨 (Futures)
        try:
            # 嘗試智慧解析 (e.g. TXFR1 -> TXF)
            cat_name = symbol[:3]
            cat = getattr(self.api.Contracts.Futures, cat_name, None)
            if cat and symbol in cat:
                return cat[symbol]
            
            # 若找不到則遍歷全部
            for attr in dir(self.api.Contracts.Futures):
                if not attr.startswith('_'):
                    category_list = getattr(self.api.Contracts.Futures, attr)
                    if hasattr(category_list, '__iter__'):
                        for c in category_list:
                            if getattr(c, 'symbol', '') == symbol or getattr(c, 'code', '') == symbol:
                                return c
        except Exception as e:
            logger.debug(f"Futures 搜尋失敗: {e}")
        
        # 3. 深度搜尋選擇權 (Options)
        try:
            cat_name = symbol[:3]
            cat = getattr(self.api.Contracts.Options, cat_name, None)
            if cat and symbol in cat:
                return cat[symbol]
                
            for attr in dir(self.api.Contracts.Options):
                if not attr.startswith('_'):
                    category_list = getattr(self.api.Contracts.Options, attr)
                    if hasattr(category_list, '__iter__'):
                        for c in category_list:
                            if getattr(c, 'symbol', '') == symbol or getattr(c, 'code', '') == symbol:
                                return c
        except Exception as e:
            logger.debug(f"Options 搜尋失敗: {e}")
                    
        return None

    def subscribe(self, symbol: str) -> str:
        contract = self.get_contract(symbol)
        if not contract: return ""
        if self.current_contract:
            try:
                self.api.quote.unsubscribe(self.current_contract, QuoteType.Tick)
                self.api.quote.unsubscribe(self.current_contract, QuoteType.BidAsk)
            except Exception as e:
                logger.debug(f"取消訂閱舊合約時發生例外: {e}")
        self.current_contract = contract
        self.api.quote.subscribe(contract, QuoteType.Tick)
        self.api.quote.subscribe(contract, QuoteType.BidAsk)
        
        # 發送初始化 Snapshot 補齊 Reference, High, Low, LimitUp, LimitDown
        try:
            snaps = self.api.snapshots([contract])
            if snaps:
                s = snaps[0]
                close_price = float(s.close)
                ref_price = float(getattr(s, 'reference', close_price))
                
                # 發送 Tick Snapshot
                tick_data = {
                    "Symbol": contract.symbol,
                    "Price": close_price,
                    "Volume": int(getattr(s, 'volume', 0)),
                    "Open": float(getattr(s, 'open', close_price)),
                    "High": float(getattr(s, 'high', close_price)),
                    "Low": float(getattr(s, 'low', close_price)),
                    "Reference": ref_price,
                    "LimitUp": float(getattr(contract, 'limit_up', ref_price * 1.1)),
                    "LimitDown": float(getattr(contract, 'limit_down', ref_price * 0.9)),
                    "TickTime": str(s.ts),
                    "Action": "Snapshot"
                }
                if self._direct_quote_callback:
                    self._direct_quote_callback(tick_data)
                
                # 發送 BidAsk Snapshot (Snapshot 只有最佳一檔)
                buy_price = float(getattr(s, 'buy_price', 0))
                sell_price = float(getattr(s, 'sell_price', 0))
                buy_vol = int(getattr(s, 'buy_volume', 0))
                sell_vol = int(getattr(s, 'sell_volume', 0))
                
                if buy_price > 0 or sell_price > 0:
                    logger.info(f"📊 Snapshot BidAsk: buy={buy_price}x{buy_vol}, sell={sell_price}x{sell_vol}")
                    bidask_data = {
                        "Symbol": contract.symbol,
                        "AskPrice": [sell_price],
                        "AskVolume": [sell_vol],
                        "BidPrice": [buy_price],
                        "BidVolume": [buy_vol],
                        "DiffBidVol": [0],
                        "DiffAskVol": [0],
                        "Time": str(s.ts)
                    }
                    if self._direct_quote_callback:
                        self._direct_quote_callback(bidask_data)
        except Exception as e:
            logger.warning(f"取得 Snapshot 失敗: {e}")
        
        QTimer.singleShot(500, self.trigger_account_update)
        return contract.symbol

    def place_order(self, symbol: str, price: float, action: Action, qty: int, order_type: OrderType = OrderType.ROD, price_type=None):
        contract = self.get_contract(symbol)
        if not contract:
            logger.warning(f"place_order: 找不到合約 {symbol}")
            return None
        account = self.active_stock_account if contract.security_type == 'STK' else self.active_futopt_account
        if not account:
            logger.warning(f"place_order: 沒有可用帳號 (security_type={contract.security_type})")
            return None
        if price_type is None:
            price_type = (StockPriceType.LMT if price > 0 else StockPriceType.MKT) if contract.security_type == 'STK' else (FuturesPriceType.LMT if price > 0 else FuturesPriceType.MKT)
        order = self.api.Order(price=price if price > 0 else 0, quantity=qty, action=action, price_type=price_type, order_type=order_type, account=account)
        try:
            return self.api.place_order(contract, order)
        except Exception as e:
            logger.error(f"place_order 失敗: {symbol} {action} {qty}@{price} — {e}")
            return None

    def get_all_accounts(self) -> List[Dict[str, str]]:
        try:
            raw_accounts = self.api.list_accounts()
            return [
                {
                    "account_id": acc.account_id,
                    "category": "Stock" if "Stock" in acc.__class__.__name__ else "Future" if "Future" in acc.__class__.__name__ else "Other",
                    "person_id": acc.person_id,
                    "broker_id": acc.broker_id,
                    "account_name": f"{acc.broker_id}-{acc.account_id}"
                }
                for acc in raw_accounts
            ]
        except Exception as e:
            logger.error(f"get_all_accounts 失敗: {e}")
            return []

    def get_account_balance(self):
        try:
            acc = self.active_stock_account or self.active_futopt_account
            if acc:
                return self.api.account_balance(acc)
            return None
        except Exception as e:
            logger.error(f"get_account_balance 失敗: {e}")
            return None

    def get_order_history(self):
        try:
            return self.api.list_trades()
        except Exception as e:
            logger.error(f"get_order_history 失敗: {e}")
            return []

    # ----- 以下為補齊的缺失方法 -----

    def update_status(self, account=None):
        """更新帳戶狀態並觸發帳務更新訊號"""
        try:
            if account:
                self.api.update_status(account)
            else:
                for acc in self.api.list_accounts():
                    self.api.update_status(acc)
            self.trigger_account_update()
        except Exception as e:
            logger.error(f"update_status 失敗: {e}")

    def update_order(self, symbol: str, action: Action, old_price: float, new_price: float, qty: int = None) -> bool:
        """改單：找到符合的委託並修改價格"""
        try:
            trades = self.api.list_trades()
            for trade in trades:
                if (trade.contract.symbol == symbol and
                    trade.order.action == action and
                    float(trade.order.price) == old_price and
                    trade.status.status.name in ['PendingSubmit', 'PreSubmitted', 'Submitted']):
                    trade.order.price = new_price
                    if qty is not None:
                        trade.order.quantity = qty
                    self.api.update_order(trade)
                    logger.info(f"改單成功: {symbol} {old_price} -> {new_price}")
                    QTimer.singleShot(500, self.trigger_account_update)
                    return True
            logger.warning(f"update_order: 找不到符合的委託 {symbol} {action} @{old_price}")
            return False
        except Exception as e:
            logger.error(f"update_order 失敗: {e}")
            return False

    def cancel_all(self, symbol: str, action: Action) -> int:
        """批次刪單：取消指定標的與方向的所有未完成委託"""
        cancel_count = 0
        try:
            trades = self.api.list_trades()
            for trade in trades:
                if (trade.contract.symbol == symbol and
                    trade.order.action == action and
                    trade.status.status.name in ['PendingSubmit', 'PreSubmitted', 'Submitted']):
                    self.api.cancel_order(trade)
                    cancel_count += 1
            if cancel_count > 0:
                logger.info(f"cancel_all: 已送出 {cancel_count} 筆刪單 ({symbol} {'Buy' if action == Action.Buy else 'Sell'})")
                QTimer.singleShot(500, self.trigger_account_update)
            return cancel_count
        except Exception as e:
            logger.error(f"cancel_all 失敗: {e}")
            return cancel_count

    def cancel_orders_by_action_price(self, symbol: str, action: Action, price: float) -> int:
        """刪除指定標的、方向、價格的未完成委託"""
        cancel_count = 0
        try:
            trades = self.api.list_trades()
            for trade in trades:
                if (trade.contract.symbol == symbol and
                    trade.order.action == action and
                    float(trade.order.price) == price and
                    trade.status.status.name in ['PendingSubmit', 'PreSubmitted', 'Submitted']):
                    self.api.cancel_order(trade)
                    cancel_count += 1
            if cancel_count > 0:
                logger.info(f"cancel_orders_by_action_price: 已刪 {cancel_count} 筆 ({symbol} @{price})")
                QTimer.singleShot(500, self.trigger_account_update)
            return cancel_count
        except Exception as e:
            logger.error(f"cancel_orders_by_action_price 失敗: {e}")
            return cancel_count

    def flatten_position(self, symbol: str) -> bool:
        """一鍵平倉：以市價反向沖銷指定標的的部位"""
        try:
            positions = self.list_positions()
            target_positions = [p for p in positions if p['symbol'] == symbol.strip().upper()]
            if not target_positions:
                logger.warning(f"flatten_position: 沒有 {symbol} 的持倉")
                return False
            for pos in target_positions:
                reverse_action = Action.Sell if pos['direction'] == 'Buy' else Action.Buy
                self.place_order(symbol, price=0, action=reverse_action, qty=pos['qty'])
                logger.info(f"flatten_position: 平倉 {symbol} {pos['direction']} {pos['qty']}")
            return True
        except Exception as e:
            logger.error(f"flatten_position 失敗: {e}")
            return False

    def reverse_position(self, symbol: str) -> bool:
        """一鍵反向：平倉後反向開倉相同口數"""
        try:
            positions = self.list_positions()
            target_positions = [p for p in positions if p['symbol'] == symbol.strip().upper()]
            if not target_positions:
                logger.warning(f"reverse_position: 沒有 {symbol} 的持倉")
                return False
            for pos in target_positions:
                reverse_action = Action.Sell if pos['direction'] == 'Buy' else Action.Buy
                # 平倉 + 反向 = 2 倍口數市價單
                self.place_order(symbol, price=0, action=reverse_action, qty=pos['qty'] * 2)
                logger.info(f"reverse_position: 反向 {symbol} {pos['direction']} {pos['qty']}")
            return True
        except Exception as e:
            logger.error(f"reverse_position 失敗: {e}")
            return False

    def add_smart_order(self, symbol: str, action: Action, qty: int, stop_price: float = 0, trailing_offset: float = 0):
        """新增本地端智慧單（停損/移動停損監控）"""
        smart_order = {
            "symbol": symbol,
            "action": action,
            "qty": qty,
            "stop_price": stop_price,
            "trailing_offset": trailing_offset,
            "highest_price": 0,
            "lowest_price": float('inf'),
            "is_triggered": False
        }
        self.smart_orders.append(smart_order)
        logger.info(f"add_smart_order: {symbol} {'Buy' if action == Action.Buy else 'Sell'} {qty}口, 停損={stop_price}, 移停={trailing_offset}")
