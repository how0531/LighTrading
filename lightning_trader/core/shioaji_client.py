import shioaji as sj
from shioaji.constant import StockPriceType, FuturesPriceType, OrderType, Action, QuoteType
from PyQt5.QtCore import QObject, pyqtSignal, QTimer
from .config import Config

class ShioajiClient(QObject):
    """
    包裝 Shioaji API 的核心單例，並提供 pyqtSignal 與 UI 層溝通
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
        self.api = sj.Shioaji(simulation=self.is_simulation)
        self.current_contract = None
        self._is_connected = False
        self._setup_callbacks()
        
        # 智慧單 (停損/移動停損) 的本地端紀錄
        self.smart_orders = []
        
        # 自動重連機制
        self.reconnect_timer = QTimer(self)
        self.reconnect_timer.timeout.connect(self.check_connection)
        self.reconnect_timer.start(10000) # 每 10 秒檢查一次
        
        # 開發期間：若 .env 已經有設定，則直接嘗試預設登入，避免 React 重整時 WebSocket 無法取得 Contracts
        if Config.API_KEY and Config.SECRET_KEY:
            print("初始化 ShioajiClient : 自動載入預設帳密...")
            # 使用 timer 延遲幾毫秒登入，確保 event loop 就緒
            QTimer.singleShot(100, self.login)

    def check_connection(self):
        """檢查連線狀態，斷線則自動重連 (具備指數退避機制)"""
        if getattr(self, '_is_reconnecting', False):
            return

        if self._is_connected:
            try:
                # 簡單呼叫取得帳戶資訊來測試連線
                if self.api.stock_account is None and self.api.futopt_account is None:
                    raise Exception("Account not found")
            except Exception as e:
                import logging
                logging.warning(f"偵測到斷線: {e}，準備自動重連...")
                print(f"偵測到斷線: {e}，準備自動重連...")
                self._is_connected = False
                self._reconnect_delay = 5000  # 初始延遲 5 秒
                self._attempt_reconnect()

    def _attempt_reconnect(self):
        self._is_reconnecting = True
        print(f"將在 {self._reconnect_delay / 1000} 秒後嘗試重連...")
        QTimer.singleShot(int(self._reconnect_delay), self._do_login_reconnect)

    def _do_login_reconnect(self):
        print("開始執行重連登入...")
        # 調用 login() 嘗試連線，login 內已包含自動重啟訂閱 current_contract 的邏輯
        success = self.login()
        if success:
            import logging
            logging.info("重連成功，已恢復連線與訂閱。")
            print("重連成功，已恢復連線與訂閱。")
            self._is_reconnecting = False
            self._reconnect_delay = 5000  # 重置延遲時間
        else:
            import logging
            self._reconnect_delay = min(getattr(self, '_reconnect_delay', 5000) * 2, 30000)  # 指數退避，最大 30 秒
            logging.warning(f"重連失敗，退避延遲增加至 {self._reconnect_delay / 1000} 秒。")
            print(f"重連失敗，退避延遲增加至 {self._reconnect_delay / 1000} 秒。")
            self._attempt_reconnect()

    def _setup_callbacks(self):
        @self.api.on_tick_stk_v1()
        def on_tick_stk_v1(exchange: sj.Exchange, tick: sj.TickSTKv1):
            q_dict = {
                "close": float(tick.close),
                "volume": tick.volume,
                "open": float(tick.open),
                "high": float(tick.high),
                "low": float(tick.low),
                "avg_price": float(tick.avg_price),
                "datetime": tick.datetime,
                "action": "Tick"
            }
            self.signal_quote_tick.emit(q_dict)
            if tick.close and self.current_contract:
                self._check_smart_orders(self.current_contract.symbol, float(tick.close))

        @self.api.quote.on_quote
        def on_quote(topic: str, quote: dict):
            # 強制轉換為 dict，避免 C++ 封裝物件 (shioaji.Quote) 的存取問題
            q_dict = dict(quote) if not isinstance(quote, dict) else quote
            
            # 原有的 Tick 捕捉保留當作備用
            if "Tick" in topic or "tick" in topic or "T" in topic.split("/")[-1]:
                self.signal_quote_tick.emit(q_dict)
                price = q_dict.get('close') or q_dict.get('Price') or 0
                if price and self.current_contract:
                    self._check_smart_orders(self.current_contract.symbol, price)
            # 原有的 BidAsk 捕捉保留當作備用 (如果 V1 沒抓到)
            elif "BidAsk" in topic or "bidask" in topic or "Q" in topic.split("/")[-1]:
                self.signal_quote_bidask.emit(q_dict)

        @self.api.on_bidask_stk_v1()
        def on_bidask_stk_v1(exchange: sj.Exchange, bidask: sj.BidAskSTKv1):
            q_dict = {
                "bid_price": [float(p) for p in bidask.bid_price],
                "bid_volume": list(bidask.bid_volume),
                "ask_price": [float(p) for p in bidask.ask_price],
                "ask_volume": list(bidask.ask_volume),
                "diff_bid_vol": list(bidask.diff_bid_vol),
                "diff_ask_vol": list(bidask.diff_ask_vol),
                "datetime": getattr(bidask, 'datetime', None)
            }
            self.signal_quote_bidask.emit(q_dict)

        @self.api.on_bidask_fop_v1()
        def on_bidask_fop_v1(exchange: sj.Exchange, bidask: sj.BidAskFOPv1):
            q_dict = {
                "bid_price": [float(p) for p in bidask.bid_price],
                "bid_volume": list(bidask.bid_volume),
                "ask_price": [float(p) for p in bidask.ask_price],
                "ask_volume": list(bidask.ask_volume),
                "diff_bid_vol": list(getattr(bidask, 'diff_bid_vol', [])),
                "diff_ask_vol": list(getattr(bidask, 'diff_ask_vol', [])),
                "datetime": getattr(bidask, 'datetime', None)
            }
            self.signal_quote_bidask.emit(q_dict)
        
        def on_order_status(state, msg: dict):
            self.signal_order_update.emit(msg)
            self.trigger_account_update()

        self.api.set_order_callback(on_order_status)

    def login(self, api_key: str = None, secret_key: str = None, simulation: bool = None, ca_path: str = None, ca_passwd: str = None) -> bool:
        key = api_key or Config.API_KEY
        secret = secret_key or Config.SECRET_KEY
        
        # 若需要切換正式/模擬模式，則必須重新初始化 Shioaji
        if simulation is not None and getattr(self, 'is_simulation', Config.SIMULATION) != simulation:
            print(f"偵測到模式切換，重新建立 Shioaji (simulation={simulation})")
            if self._is_connected:
                self.logout()
            self.is_simulation = simulation
            self.api = sj.Shioaji(simulation=self.is_simulation)
            self._setup_callbacks()
        
        if not key or not secret:
            self.signal_login_status.emit(False, "API Key 或 Secret 尚未設定")
            return False

        try:
            # 處理 Windows 路徑轉義問題 (反斜線轉斜線)
            current_ca_path = (ca_path or Config.CA_PATH).replace("\\", "/")
            current_ca_passwd = ca_passwd or Config.CA_PASSWD
            
            print(f"嘗試登入 Shioaji... (Simulation: {self.is_simulation})")
            self.api.login(
                api_key=key,
                secret_key=secret
            )
            
            if not self.is_simulation and current_ca_path and current_ca_passwd:
                print(f"正式環境登入，正在啟用憑證: {current_ca_path}")
                self.api.activate_ca(
                    ca_path=current_ca_path,
                    ca_passwd=current_ca_passwd,
                )
            
            self._is_connected = True
            self.signal_login_status.emit(True, "登入成功")
            self.trigger_account_update()
            
            # 若之前有訂閱商品，重連後重新訂閱
            if self.current_contract:
                self.subscribe(self.current_contract.symbol)
                
            return True
        except Exception as e:
            self._is_connected = False
            self.signal_login_status.emit(False, f"登入失敗: {str(e)}")
            return False

    def logout(self):
        try:
            self.api.logout()
            self._is_connected = False
        except:
             pass

    def get_contract(self, symbol: str):
        if not symbol: return None
        
        # 先嘗試當作股票代碼，再嘗試期貨
        contract = self.api.Contracts.Stocks.get(symbol)
        if not contract:
            contract = self.api.Contracts.Futures.get(symbol)
        if not contract:
            # 嘗試搜尋選擇權
            contract = self.api.Contracts.Options.get(symbol)
        return contract

    def subscribe(self, symbol: str) -> bool:
        contract = self.get_contract(symbol)
        if not contract:
            return False
            
        if self.current_contract:
            try:
                self.api.quote.unsubscribe(self.current_contract, quote_type=QuoteType.Tick)
                self.api.quote.unsubscribe(self.current_contract, quote_type=QuoteType.BidAsk)
            except:
                pass

        self.current_contract = contract

        self.api.quote.subscribe(contract, quote_type=QuoteType.Tick)
        self.api.quote.subscribe(contract, quote_type=QuoteType.BidAsk)
        
        # 為了避免在盤後或無交易時前端沒有資料，主動發送一次 Snapshot
        try:
            snapshots = self.api.snapshots([contract])
            if snapshots:
                snap = snapshots[0]
                # 計算準備真實漲跌停價
                ref_price = getattr(snap, 'reference', snap.close)
                l_up = getattr(contract, 'limit_up', 0)
                l_dn = getattr(contract, 'limit_down', 0)
                
                # 若合約沒有自帶，再考慮 fallback
                if not l_up: l_up = round(ref_price * 1.1, 2)
                if not l_dn: l_dn = round(ref_price * 0.9, 2)
                
                # 模擬 Tick 結構
                tick_sim = {
                    "close": snap.close,
                    "volume": getattr(snap, 'volume', 0),
                    "open": getattr(snap, 'open', snap.close),
                    "high": getattr(snap, 'high', snap.close),
                    "low": getattr(snap, 'low', snap.close),
                    "reference": ref_price,
                    "limit_up": l_up,
                    "limit_down": l_dn,
                    "datetime": snap.ts,
                    "action": "Snapshot"
                }
                self.signal_quote_tick.emit(tick_sim)
                
                # 計算該檔股票的跳動點位基準 (假設目前簡單使用 0.5 遞增作為範例，實務需根據股價級距計算)
                close_px = snap.close
                tick_size = 0.5 if close_px < 50 else (1.0 if close_px < 100 else (5.0 if close_px < 500 else 1.0))
                # 台積電股價高於 500，跳動單位是 5.0，上面簡單邏輯給 1.0 反而不太合，為模擬逼真，我們寫個簡單判斷
                if close_px >= 1000: tick_size = 5.0
                elif close_px >= 500: tick_size = 1.0
                elif close_px >= 100: tick_size = 0.5
                elif close_px >= 50: tick_size = 0.1
                else: tick_size = 0.05
                
                # 模擬 BidAsk 結構 (因為 Snapshot 只提供一檔最佳買賣價，我們將最佳報價保留，其餘四檔用價格推算，量維持真實無報價的 0)
                bp1 = snap.buy_price if hasattr(snap, 'buy_price') and snap.buy_price > 0 else close_px - tick_size
                ap1 = snap.sell_price if hasattr(snap, 'sell_price') and snap.sell_price > 0 else close_px + tick_size
                
                bid_price = [bp1, bp1 - tick_size*1, bp1 - tick_size*2, bp1 - tick_size*3, bp1 - tick_size*4]
                bid_volume = [getattr(snap, 'buy_volume', 0), 0, 0, 0, 0]
                
                ask_price = [ap1, ap1 + tick_size*1, ap1 + tick_size*2, ap1 + tick_size*3, ap1 + tick_size*4]
                ask_volume = [getattr(snap, 'sell_volume', 0), 0, 0, 0, 0]
                
                bidask_sim = {
                    "bid_price": bid_price,
                    "bid_volume": bid_volume,
                    "ask_price": ask_price,
                    "ask_volume": ask_volume,
                    "datetime": snap.ts
                }
                self.signal_quote_bidask.emit(bidask_sim)
        except Exception as e:
            print(f"提取 Snapshot 失敗: {e}")
            
        return True

    def place_order(self, symbol: str, price: float, action: Action, qty: int, order_type: OrderType = OrderType.ROD, price_type=None):
        contract = self.get_contract(symbol)
        if not contract:
            print("找不到合約，無法下單")
            return None

        if contract.security_type == 'STK':
            if price_type is None:
                price_type = StockPriceType.LMT if price > 0 else StockPriceType.MKT
            account = self.api.stock_account
        else:
            if price_type is None:
                price_type = FuturesPriceType.LMT if price > 0 else FuturesPriceType.MKT
            account = self.api.futopt_account

        # Maximum Position Limit (部位上限 10 口) 防呆機制
        positions = self.list_positions(account)
        current_pos_qty = sum(p.quantity for p in positions if p.contract.symbol == symbol)
        if current_pos_qty + qty > 10:
            print(f"下單駁回: {symbol} 累計部位將達 {current_pos_qty + qty} 口，超過單一商品 10 口上限！")
            return None

        order = self.api.Order(
            price=price if price > 0 else 0,
            quantity=qty,
            action=action,
            price_type=price_type,
            order_type=order_type,
            account=account
        )

        try:
            trade = self.api.place_order(contract, order)
            return trade
        except Exception as e:
            print(f"下單失敗: {e}")
            return None

    def add_smart_order(self, symbol: str, action: Action, qty: int, stop_price: float = 0, trailing_offset: float = 0):
        """新增智慧單 (本地監控)"""
        self.smart_orders.append({
            "symbol": symbol,
            "action": action,
            "qty": qty,
            "stop_price": stop_price,
            "trailing_offset": trailing_offset,
            "highest_price": None,
            "lowest_price": None
        })
        print(f"已新增智慧單 - 商品:{symbol} 方向:{action} 數量:{qty} 停損價:{stop_price} 移動停損點數:{trailing_offset}")

    def _check_smart_orders(self, symbol: str, current_price: float):
        """檢查所有本地智慧單是否觸發"""
        triggered_orders = []
        for order in self.smart_orders:
            if order["symbol"] != symbol:
                continue
                
            trigger = False
            
            # 處理移動停損高低點更新
            if order["highest_price"] is None or current_price > order["highest_price"]:
                order["highest_price"] = current_price
            if order["lowest_price"] is None or current_price < order["lowest_price"]:
                order["lowest_price"] = current_price
                
            if order["action"] == Action.Sell:
                # 買進部位的停損 (價格跌破停損價)
                if order["stop_price"] > 0 and current_price <= order["stop_price"]:
                    trigger = True
                    print(f"觸發停損賣出: 價格 {current_price} <= 停損價 {order['stop_price']}")
                # 移動停損 (從高點回落指定點數)
                elif order["trailing_offset"] > 0 and current_price <= (order["highest_price"] - order["trailing_offset"]):
                    trigger = True
                    print(f"觸發移動停損賣出: 價格 {current_price} <= 高點 {order['highest_price']} - 回落 {order['trailing_offset']}")
            
            elif order["action"] == Action.Buy:
                # 賣出部位的停損 (價格突破停損價)
                if order["stop_price"] > 0 and current_price >= order["stop_price"]:
                    trigger = True
                    print(f"觸發停損買進: 價格 {current_price} >= 停損價 {order['stop_price']}")
                # 移動停損 (從低點反彈指定點數)
                elif order["trailing_offset"] > 0 and current_price >= (order["lowest_price"] + order["trailing_offset"]):
                    trigger = True
                    print(f"觸發移動停損買進: 價格 {current_price} >= 低點 {order['lowest_price']} + 反彈 {order['trailing_offset']}")

            if trigger:
                self.place_order(symbol, price=0, action=order["action"], qty=order["qty"])
                triggered_orders.append(order)

        # 移除已觸發的智慧單
        for order in triggered_orders:
            self.smart_orders.remove(order)

    def cancel_order(self, trade):
        try:
            self.api.cancel_order(trade)
            self.update_status()
            return True
        except Exception as e:
            print(f"刪單失敗: {e}")
            return False

    def cancel_all(self, symbol: str, action: Action = None):
        """
        取消所有特定商品(與方向)的未成交委託
        """
        try:
            contract = self.get_contract(symbol)
            if not contract: return 0
            
            account = self.api.stock_account if contract.security_type == 'STK' else self.api.futopt_account
            self.api.update_status(account)
            trades = self.api.list_trades()
            
            cancel_count = 0
            for t in trades:
                # 檢查標的、方向(選填)以及是否為可刪除狀態
                if t.contract.symbol == symbol:
                    if action is None or t.order.action == action:
                        if t.status.status.name in ["PendingSubmit", "PreSubmitted", "Submitted"]:
                            if self.cancel_order(t):
                                cancel_count += 1
            return cancel_count
        except Exception as e:
            print(f"批量刪單失敗: {e}")
            return 0

    def cancel_orders_by_action_price(self, symbol: str, action: Action, price: float):
        try:
            contract = self.get_contract(symbol)
            if not contract: return
            
            account = self.api.stock_account if contract.security_type == 'STK' else self.api.futopt_account
            self.api.update_status(account)
            trades = self.api.list_trades()
            
            for t in trades:
                if t.contract.symbol == symbol and t.order.action == action and t.order.price == price:
                    if t.status.status.name in ["PendingSubmit", "PreSubmitted", "Submitted"]:
                        self.cancel_order(t)
        except Exception as e:
            print(f"刪單(按價格)失敗: {e}")

    def update_status(self):
        try:
            self.api.update_status(self.api.stock_account)
            self.api.update_status(self.api.futopt_account)
            self.trigger_account_update()
        except:
             pass

    def list_positions(self, account_id=None):
        try:
            if account_id:
                # 尋找匹配的帳號物件
                target_acc = next((acc for acc in self.api.list_accounts() if acc.account_id == account_id), None)
                if target_acc:
                    return self.api.list_positions(target_acc)
                return []
            
            positions = []
            if self.api.stock_account:
                stock_pos = self.api.list_positions(self.api.stock_account)
                if stock_pos: positions.extend(stock_pos)
            if self.api.futopt_account:
                fut_pos = self.api.list_positions(self.api.futopt_account)
                if fut_pos: positions.extend(fut_pos)
            return positions
        except Exception as e:
            print(f"查詢持倉失敗: {e}")
            return []

    def list_profit_loss(self, account_id=None):
        try:
            if account_id:
                target_acc = next((acc for acc in self.api.list_accounts() if acc.account_id == account_id), None)
                if target_acc:
                    return self.api.list_profit_loss(target_acc)
                return []
                
            pnl = []
            if self.api.stock_account:
                stock_pnl = self.api.list_profit_loss(self.api.stock_account)
                if stock_pnl: pnl.extend(stock_pnl)
            if self.api.futopt_account:
                fut_pnl = self.api.list_profit_loss(self.api.futopt_account)
                if fut_pnl: pnl.extend(fut_pnl)
            return pnl
        except Exception as e:
            print(f"查詢損益失敗: {e}")
            return []

    def get_account_balance(self):
        """
        獲取帳戶餘額資訊 (優先整合股票與期貨)
        """
        try:
            # 優先獲取股票帳戶餘額 (Shioaji 主要將交割帳戶算在此)
            if self.api.stock_account:
                return self.api.account_balance(self.api.stock_account)
            # 若無股票，才回傳期貨的保證金餘額
            elif self.api.futopt_account:
                return self.api.account_balance(self.api.futopt_account)
            return None
        except Exception as e:
            print(f"獲取帳戶餘額失敗: {e}")
            return None

    def get_all_accounts(self):
        """獲取所有可用帳號資訊"""
        try:
            raw_accounts = self.api.list_accounts()
            print(f"DEBUG: 原始帳號清單: {raw_accounts}")
            accounts = []
            for acc in raw_accounts:
                # 判斷類別 (Shioaji 物件可能沒有 category 屬性，改用類別名稱判斷)
                class_name = acc.__class__.__name__
                category = "Stock" if "Stock" in class_name else "Future" if "Future" in class_name else "Other"
                
                # 組合介面顯示名稱
                display_name = f"{acc.broker_id}-{acc.account_id}"
                if hasattr(acc, 'username') and acc.username:
                    display_name += f"-{acc.username}"
                
                accounts.append({
                    "account_id": acc.account_id,
                    "category": category, # 改傳回 Stock 或 Future 字符串
                    "person_id": acc.person_id,
                    "broker_id": acc.broker_id,
                    "account_name": display_name
                })
            return accounts
        except Exception as e:
            print(f"獲取帳號列表發生異常: {e}")
            import traceback
            traceback.print_exc()
            return []

    def get_order_history(self):
        """
        獲取當日委託/成交歷史
        """
        try:
            self.api.update_status(self.api.stock_account)
            self.api.update_status(self.api.futopt_account)
            trades = self.api.list_trades()
            return trades
        except Exception as e:
            print(f"獲取委託歷史失敗: {e}")
            return []

    def trigger_account_update(self):
        try:
            # 彙整所有可用帳戶的狀態
            if self.api.stock_account:
                self.api.update_status(self.api.stock_account)
            if self.api.futopt_account:
                self.api.update_status(self.api.futopt_account)
            
            all_trades = self.api.list_trades()
            
            working = sum(1 for t in all_trades if t.status.status.name in ["PendingSubmit", "PreSubmitted", "Submitted"])
            cancelled = sum(1 for t in all_trades if t.status.status.name == "Cancelled")
            filled = sum(1 for t in all_trades if t.status.status.name == "Filled")
            
            # 使用我們剛修正過的整合型 list_positions 獲取資料
            positions = self.list_positions()
            
            # 建立詳細部位清單給前端
            detailed_positions = []
            open_interest = 0
            for p in positions:
                # 判斷是股票還是期貨
                is_stock = hasattr(p, 'cond')
                qty = getattr(p, 'quantity', 0) or getattr(p, 'real_quantity', 0)
                
                if is_stock:
                    direction = "Buy" if p.cond.name in ["Cash", "MarginTrading"] else "Sell"
                    symbol = p.code
                else:
                    direction = "Buy" if getattr(p, 'direction', Action.Buy) == Action.Buy else "Sell"
                    symbol = (p.contract.symbol if hasattr(p, 'contract') else (getattr(p, 'code', 'Unknown')))

                detailed_positions.append({
                    "symbol": symbol,
                    "qty": qty,
                    "direction": direction,
                    "price": float(getattr(p, 'price', 0)),
                    "pnl": float(getattr(p, 'pnl', 0))
                })
                
                # 計算未平倉量 (買加賣減，簡化表達)
                open_interest += qty if direction == "Buy" else -qty

            # 彙總損益 (從整合後的損益清單)
            pnls = self.list_profit_loss()
            total_pnl = sum(float(getattr(p, 'pnl', 0)) for p in pnls) if pnls else 0
            
            summary = {
                "當日交易": len(all_trades),
                "委託": len(all_trades),
                "刪單": cancelled,
                "未成交": working,
                "成交": filled,
                "未平倉": open_interest,
                "參考損益": total_pnl,
                "positions": detailed_positions
            }
            self.signal_account_update.emit(summary)
        except Exception as e:
            print(f"發送帳戶更新訊號失敗: {e}")
            pass
