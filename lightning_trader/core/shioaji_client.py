import shioaji as sj
from shioaji.constant import (
    StockPriceType, FuturesPriceType, OrderType, Action, QuoteType,
    StockOrderLot, StockOrderCond,
)
import threading
from .config import Config
from .event_bus import Signal
from .symbol_resolver import SymbolResolver
import json
import logging
import time
from datetime import datetime, time as dtime
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

class ShioajiClient:
    """
    專業級 Shioaji 核心客戶端 - 完整報價與部位同步版 (無 PyQt5 依賴)
    """
    def __init__(self, event_bus=None):
        self.signal_login_status = Signal()
        self.signal_order_update = Signal()
        self.signal_trade_update = Signal()
        self.signal_account_update = Signal()

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

        # ★ 統一商品代號正規化（解期貨 tick.code vs user-facing symbol 不一致）
        self.symbol_resolver = SymbolResolver()

        # ★ 多商品即時報價快取（key = canonical symbol）
        self._latest_prices: Dict[str, float] = {}
        # ★ 成交均價快取：ordno → deal_price
        self._deal_prices: Dict[str, float] = {}
        # ★ 切換訂閱用的 mutex，避免兩筆 subscribe 競態
        self._subscribe_lock = threading.Lock()
        # ★ 背景訂閱的商品（持倉/自選）— 重連後要全部重訂，否則 PnL 無聲變舊
        self._background_symbols: set = set()

        self._setup_callbacks()
        self.last_message_time = time.time()
        self._start_reconnect_timer()

    def _start_reconnect_timer(self):
        # 巡檢間隔縮短到 5 秒（搭配 15s watchdog），最壞 20s 內偵測到靜默斷線
        self._reconnect_timer = threading.Timer(5.0, self._on_reconnect_timer_tick)
        self._reconnect_timer.daemon = True
        self._reconnect_timer.start()

    def _on_reconnect_timer_tick(self):
        self.check_connection()
        self._start_reconnect_timer()

    def _contract_in_session(self, contract, now: Optional[datetime] = None) -> bool:
        """判斷「單一合約」此刻是否在其行情時段內。

        - 'STK' → TSE 日盤；其餘（期貨/選擇權）→ TAIFEX 日盤+夜盤
          （與 place_order 選帳號用同一個 security_type 判別）
        - 夜盤 15:00–05:00 跨午夜：start > end 時，now >= start 或 now <= end 即在盤中
        - contract=None → False
        """
        if contract is None:
            return False
        sec_type = getattr(contract, "security_type", None)
        sessions = Config.TSE_SESSIONS if sec_type == 'STK' else Config.TAIFEX_SESSIONS
        now_t = (now or datetime.now()).time()
        for start_s, end_s in sessions:
            start = dtime(*(int(x) for x in start_s.split(":")))
            end = dtime(*(int(x) for x in end_s.split(":")))
            if start <= end:
                if start <= now_t <= end:
                    return True
            else:  # 跨午夜（例如 15:00 → 翌日 05:00）
                if now_t >= start or now_t <= end:
                    return True
        return False

    def _in_quote_session(self, now: Optional[datetime] = None) -> bool:
        """current_contract 此刻是否在行情時段內（沒有合約 → False）。"""
        return self._contract_in_session(self.current_contract, now)

    def _any_subscribed_in_session(self, now: Optional[datetime] = None) -> bool:
        """#11：只要「任一訂閱商品（主 current_contract + 所有背景訂閱）」在其
        交易時段內，就該有行情、否則視為靜默斷線。

        修正前只看 current_contract 單一商品時段：current_contract=None 但有
        背景訂閱（持倉/自選）在盤中時，watchdog 不會觸發、靜默斷線抓不到。
        """
        if self._contract_in_session(self.current_contract, now):
            return True
        for sym in list(getattr(self, "_background_symbols", set()) or ()):
            try:
                contract = self.get_contract(sym)
            except Exception:
                contract = None
            if self._contract_in_session(contract, now):
                return True
        return False

    def check_connection(self):
        if getattr(self, '_is_reconnecting', False): return

        # 1. 檢查帳戶清單 API 存取
        api_ok = False
        if self._is_connected:
            try:
                self.api.list_accounts()
                api_ok = True
            except Exception as e:
                logger.warning(f"連線檢查失敗 (API 異常)，準備重連: {e}")
                
        # 2. 檢查 Watchdog (最後收到行情封包的時間)
        # 縮短為 15 秒：當沖場景每秒都有 tick，超過 15 秒沒任何封包就視為靜默斷線
        # ★ 盤後（收盤～開盤間）本來就沒有 tick —— 只在行情時段內才把靜默視為斷線，
        #   否則盤後每 ~20 秒重登一次、整夜無限迴圈。list_accounts 檢查仍然照跑，
        #   真正的 session 死亡在盤後一樣抓得到。
        watchdog_timeout = 15
        is_stale = False
        # #11：對「所有訂閱商品（主 + 背景）的時段聯集」判斷 —— 只要有任一
        #   訂閱商品在盤中就該有行情；current_contract=None 但有背景訂閱也能觸發
        if api_ok and self._is_connected and self._any_subscribed_in_session():
            elapsed = time.time() - getattr(self, 'last_message_time', time.time())
            if elapsed > watchdog_timeout:
                logger.warning(f"Watchdog 觸發：超過 {watchdog_timeout} 秒未收到報價，疑似靜默斷線 (elapsed={elapsed:.1f}s)")
                is_stale = True

        if not api_ok or is_stale:
            if self._is_connected:
                self._is_connected = False
                if self.event_bus:
                    try:
                        self.event_bus.on_connection_state.emit("disconnected")
                    except Exception:
                        pass
                self._attempt_reconnect()

    def _attempt_reconnect(self):
        self._is_reconnecting = True
        if self.event_bus:
            try:
                self.event_bus.on_connection_state.emit("reconnecting")
            except Exception:
                pass
        threading.Timer(5.0, self._do_login_reconnect).start()

    def _do_login_reconnect(self):
        if self.login():
            logger.info("重連成功")
            self._is_reconnecting = False
            self.last_message_time = time.time() # 重置時間

            # 重新訂閱原合約
            if self.current_contract:
                logger.info(f"重新啟動合約訂閱: {self.current_contract.symbol}")
                try:
                    self.subscribe(self.current_contract.symbol)
                except Exception as e:
                    logger.error(f"還原合約訂閱失敗: {e}")
        else:
            logger.warning("重連失敗，10 秒後重試")
            threading.Timer(10.0, self._do_login_reconnect).start()

    def _resubscribe_background(self):
        """重連 / 重新登入後把所有背景訂閱（持倉、自選）補回來。"""
        for sym in list(self._background_symbols):
            try:
                self.subscribe_background(sym)
            except Exception as e:
                logger.warning(f"重連後補訂背景商品 {sym} 失敗: {e}")

    def _setup_callbacks(self):
        # === Shioaji v1 回呼（新版 SDK 預設格式） ===
        # TickSTKv1 / BidAskSTKv1 → 統一 dict → _direct_quote_callback → asyncio Queue → WebSocket

        def _on_tick_stk(exchange, tick):
            """股票 Tick 回呼"""
            self.last_message_time = time.time()
            try:
                symbol = self.symbol_resolver.canonical(getattr(tick, "code", ""))
                q = {
                    "Symbol": symbol,
                    "Price": float(tick.close),
                    "Volume": int(tick.volume),
                    # 交易所當日累計成交量 — 前端不用再自己累加（避免重訂閱/重連時重複計數）
                    "TotalVolume": int(getattr(tick, "total_volume", 0) or 0),
                    "Open": float(tick.open),
                    "High": float(tick.high),
                    "Low": float(tick.low),
                    "AvgPrice": float(tick.avg_price),
                    "TickType": int(tick.tick_type),
                    "TickTime": str(tick.datetime),
                }
                if q["Price"] > 0 and symbol:
                    self._latest_prices[symbol] = q["Price"]
                    # on_tick 事件統一由 bridge.on_shioaji_quote 發射（單一來源，
                    # 之前這裡也 emit 導致所有消費者每個 tick 處理兩次）
                    if self._direct_quote_callback:
                        self._direct_quote_callback(q)
            except Exception as e:
                logger.error(f"_on_tick_stk 錯誤: {e}")

        def _on_bidask_stk(exchange, bidask):
            """股票 BidAsk 回呼"""
            self.last_message_time = time.time()
            try:
                symbol = self.symbol_resolver.canonical(getattr(bidask, "code", ""))
                if not symbol:
                    return
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
            self.last_message_time = time.time()
            try:
                symbol = self.symbol_resolver.canonical(getattr(tick, "code", ""))
                q = {
                    "Symbol": symbol,
                    "Price": float(tick.close),
                    "Volume": int(tick.volume),
                    # 交易所當日累計成交量（同 _on_tick_stk）
                    "TotalVolume": int(getattr(tick, "total_volume", 0) or 0),
                    "Open": float(tick.open),
                    "High": float(tick.high),
                    "Low": float(tick.low),
                    "AvgPrice": float(getattr(tick, "avg_price", 0)),
                    "TickType": int(tick.tick_type),
                    "TickTime": str(tick.datetime),
                }
                if q["Price"] > 0 and symbol:
                    self._latest_prices[symbol] = q["Price"]
                    # on_tick 事件統一由 bridge.on_shioaji_quote 發射（見 _on_tick_stk 註解）
                    if self._direct_quote_callback:
                        self._direct_quote_callback(q)
            except Exception as e:
                logger.error(f"_on_tick_fop 錯誤: {e}")

        def _on_bidask_fop(exchange, bidask):
            """期貨/選擇權 BidAsk 回呼"""
            self.last_message_time = time.time()
            try:
                symbol = self.symbol_resolver.canonical(getattr(bidask, "code", ""))
                if not symbol:
                    return
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

        # Fallback: 舊版 dict 報價回呼 (某些期貨 BidAsk 只有這個有反應)
        def _on_quote_dict(topic, quote):
            self.last_message_time = time.time()
            try:
                if not isinstance(quote, dict):
                    return
                original_symbol = quote.get("Symbol")
                if not original_symbol:
                    parts = topic.split('/')
                    if len(parts) >= 4:
                        original_symbol = parts[3]
                if not original_symbol:
                    return
                canonical = self.symbol_resolver.canonical(original_symbol)
                if not canonical:
                    return
                quote["Symbol"] = canonical
                if self._direct_quote_callback:
                    self._direct_quote_callback(quote)
            except Exception as e:
                logger.error(f"Fallback 報價回呼錯誤: {e}")

        self.api.quote.set_quote_callback(_on_quote_dict)
        logger.info("✅ 已註冊 Fallback 報價回呼 (set_quote_callback)")

        def on_order_status(state, msg: dict):
            # ★ 攔截 Deal 事件，提取成交均價並快取存儲
            state_name = str(state).lower()
            is_deal = 'deal' in state_name
            if is_deal:
                ordno = msg.get('ordno', '') or msg.get('seqno', '')
                deal_price = msg.get('price', 0)
                if ordno and deal_price:
                    self._deal_prices[ordno] = float(deal_price)
                    logger.debug(f"★ 成交均價快取: ordno={ordno} price={deal_price}")
            self.signal_order_update.emit(msg)
            # ★ Deal（成交）另外走 signal_trade_update →
            #   journal 落地 / on_fill 事件 / 已實現損益餵風控 / webhook。
            #   這個 signal 之前從來沒有人 emit，整條成交處理鏈在生產環境是死的。
            if is_deal:
                payload = dict(msg) if isinstance(msg, dict) else {"raw": str(msg)}
                payload.setdefault("state", str(state))
                self.signal_trade_update.emit(payload)
            threading.Timer(0.5, self.trigger_account_update).start()

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
            if self.event_bus:
                try:
                    self.event_bus.on_connection_state.emit("connected")
                except Exception:
                    pass
            threading.Timer(1.0, self.trigger_account_update).start()
            if self.current_contract: self.subscribe(self.current_contract.symbol)
            # 補回所有背景訂閱（持倉 / 自選）— 之前重連只還原 current_contract
            self._resubscribe_background()
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
        """回傳所有支援帳號的持倉（寬鬆版）：查詢失敗回 []（best-effort）。

        多數呼叫端（帳務廣播 / PnL / 面板）要的是 best-effort 快照，失敗回 []
        即可。需要「區分查詢失敗與真無倉」的關鍵路徑（退訂前的持倉保護）改用
        list_positions_strict()。
        """
        try:
            return self.list_positions_strict()
        except Exception as e:
            logger.error(f"list_positions 總體錯誤: {e}")
            return []

    def list_positions_strict(self) -> List[Dict[str, Any]]:
        """回傳所有支援帳號的持倉（嚴格版，#12）。

        必須能區分「查詢失敗」與「真的無倉」——
          - 查詢成功但無倉 → 回 []（真無倉）
          - 所有帳號查詢都失敗（或 list_accounts 失敗）→ raise，
            讓呼叫端（退訂前查倉保護等）能保守處理，而非把失敗當成空倉。
        之前 list_positions 一律吞例外回 []，使 unsubscribe_background 的持倉
        保護變成死碼：查倉失敗被當「無倉」→ 錯誤退訂持倉商品，PnL 串流無聲中斷。
        """
        all_pos: List[Dict[str, Any]] = []
        # list_accounts 失敗 → 直接往外拋（整體查詢失敗）
        accounts = self.api.list_accounts()
        # 過濾掉不支援 list_positions 的帳號類型 (H=海外期貨)
        UNSUPPORTED_TYPES = {'H'}
        queried = 0
        failed = 0
        for acc in accounts:
            acc_type = getattr(acc, 'account_type', None) or getattr(acc, 'category', '')
            if str(acc_type).upper() in UNSUPPORTED_TYPES:
                continue
            try:
                self.api.update_status(acc)
                positions = self.api.list_positions(acc)
                queried += 1
                for p in positions:
                    qty = int(p.quantity)
                    raw_code = str(p.code).strip().upper()
                    # canonical：若 resolver 有 alias 就用 user-facing symbol，否則保留 raw
                    canonical = self.symbol_resolver.canonical(raw_code) or raw_code
                    all_pos.append({
                        "symbol": canonical,
                        "qty": qty,
                        "direction": "Buy" if p.direction == Action.Buy else "Sell",
                        "price": float(p.price),
                        "pnl": float(p.pnl),
                        "account": f"{acc.broker_id}-{acc.account_id}"
                    })
            except Exception as e:
                failed += 1
                logger.warning(f"查詢帳號 {acc.account_id} 持倉失敗: {e}")
        # 有支援帳號但「全部」查詢失敗 → 這是查詢失敗、不是無倉
        if queried == 0 and failed > 0:
            raise RuntimeError(f"list_positions: 所有帳號持倉查詢失敗（{failed} 個帳號）")
        return all_pos

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
        logger.info(f"🎯 成功取得合約: symbol={getattr(contract, 'symbol', None)}, code={getattr(contract, 'code', None)}, name={getattr(contract, 'name', None)}")
        # ★ subscribe mutex：避免兩筆切換交錯導致回呼帶錯 symbol
        with self._subscribe_lock:
            old_contract = self.current_contract
            # 切換到不同合約時，把舊合約的 latest price 清掉（避免新商品 DOM 用到舊價）
            if old_contract is not None and getattr(old_contract, "symbol", "") != getattr(contract, "symbol", ""):
                # ★ 防誤殺：舊商品若在背景訂閱清單（持倉/自選）中，絕不能取消訂閱 —
                #   watchlist / PnL 依賴同一條 Tick/BidAsk 串流，取消會讓背景報價無聲斷掉。
                old_canonical = self.symbol_resolver.canonical(getattr(old_contract, "symbol", ""))
                if old_canonical in self._background_symbols:
                    logger.info(f"跳過取消訂閱 {old_canonical}：仍在背景訂閱清單（持倉/自選）")
                else:
                    try:
                        self.api.quote.unsubscribe(old_contract, QuoteType.Tick)
                        self.api.quote.unsubscribe(old_contract, QuoteType.BidAsk)
                    except Exception as e:
                        logger.debug(f"取消訂閱舊合約時發生例外: {e}")
                # 注意：持倉商品的價格仍由 subscribe_background 維護，不在此清除
            self.current_contract = contract
            # ★ 登記到 resolver，確保 tick.code 能映射回 user-facing symbol
            self.symbol_resolver.register(contract)
            self.api.quote.subscribe(contract, QuoteType.Tick)
            self.api.quote.subscribe(contract, QuoteType.BidAsk)
        
        # 發送初始化 Snapshot 補齊 Reference, High, Low, LimitUp, LimitDown
        canonical = self.symbol_resolver.canonical(contract.symbol)
        try:
            snaps = self.api.snapshots([contract])
            if snaps:
                s = snaps[0]
                close_price = float(s.close)
                ref_price = float(getattr(s, 'reference', close_price))
                if close_price > 0:
                    self._latest_prices[canonical] = close_price

                # 發送 Tick Snapshot
                tick_data = {
                    "Symbol": canonical,
                    "Price": close_price,
                    "Volume": int(getattr(s, 'volume', 0)),
                    "TotalVolume": int(getattr(s, 'total_volume', 0) or 0),
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
                        "Symbol": canonical,
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
        
        threading.Timer(0.5, self.trigger_account_update).start()
        return contract.symbol

    def subscribe_background(self, symbol: str) -> str:
        """
        背景訂閱商品報價：不切換 current_contract，但
          1. 登記 resolver alias，讓 tick.code 回呼能對應到 user-facing symbol
          2. 訂閱 Tick（PnL 計算所需）+ BidAsk（watchlist 切回時的一檔買賣盤）
          3. 推送一份 Snapshot（Reference/LimitUp/LimitDown/初始 BidAsk）給前端，
             避免使用者切換到該商品時看不到漲跌停或一檔買賣盤

        回傳 canonical symbol（tick 廣播用的 key；失敗回 ""）——
        呼叫端（WS watch ack）必須把 canonical 告訴前端，否則使用者輸入
        「2330」而 tick 帶「TSE2330」時，前端對不上 key、報價永遠不顯示。
        """
        contract = self.get_contract(symbol)
        if not contract:
            logger.warning(f"subscribe_background: 找不到合約 {symbol}")
            return ""
        try:
            self.symbol_resolver.register(contract)
            canonical = self.symbol_resolver.canonical(contract.symbol)

            self.api.quote.subscribe(contract, QuoteType.Tick)
            # ★ 背景商品也訂 BidAsk：watchlist 切回該商品時 DOM 一檔買賣盤才不會停在 snapshot
            self.api.quote.subscribe(contract, QuoteType.BidAsk)
            self._background_symbols.add(canonical)
            logger.info(f"  ✅ 背景訂閱 {symbol} Tick+BidAsk 成功 (canonical={canonical})")

            # 推送 Snapshot 補齊 Reference / LimitUp / LimitDown / 初始一檔 BidAsk
            try:
                snaps = self.api.snapshots([contract])
                if snaps:
                    s = snaps[0]
                    close_price = float(getattr(s, "close", 0))
                    ref_price = float(getattr(s, "reference", close_price))
                    if close_price > 0:
                        self._latest_prices[canonical] = close_price
                    tick_data = {
                        "Symbol": canonical,
                        "Price": close_price,
                        "Volume": int(getattr(s, "volume", 0)),
                        "TotalVolume": int(getattr(s, "total_volume", 0) or 0),
                        "Open": float(getattr(s, "open", close_price)),
                        "High": float(getattr(s, "high", close_price)),
                        "Low": float(getattr(s, "low", close_price)),
                        "Reference": ref_price,
                        "LimitUp": float(getattr(contract, "limit_up", ref_price * 1.1)),
                        "LimitDown": float(getattr(contract, "limit_down", ref_price * 0.9)),
                        "TickTime": str(getattr(s, "ts", "")),
                        "Action": "Snapshot",
                    }
                    if self._direct_quote_callback:
                        self._direct_quote_callback(tick_data)

                    buy_price = float(getattr(s, "buy_price", 0))
                    sell_price = float(getattr(s, "sell_price", 0))
                    if buy_price > 0 or sell_price > 0:
                        bidask_data = {
                            "Symbol": canonical,
                            "AskPrice": [sell_price],
                            "AskVolume": [int(getattr(s, "sell_volume", 0))],
                            "BidPrice": [buy_price],
                            "BidVolume": [int(getattr(s, "buy_volume", 0))],
                            "DiffBidVol": [0],
                            "DiffAskVol": [0],
                            "Time": str(getattr(s, "ts", "")),
                        }
                        if self._direct_quote_callback:
                            self._direct_quote_callback(bidask_data)
            except Exception as snap_err:
                logger.warning(f"subscribe_background {symbol} snapshot 失敗: {snap_err}")
            return canonical
        except Exception as e:
            logger.warning(f"subscribe_background {symbol} 失敗: {e}")
            return ""

    def unsubscribe_background(self, symbol: str, held_canonicals=None) -> bool:
        """
        退訂背景商品報價（UX 批次 4 Item 10：自選清單移除後不再洩漏 Tick+BidAsk 訂閱）。

        held_canonicals（#13）：已持倉的 canonical symbol 集合。若呼叫端已「一次抓好」
        持倉集合（批次退訂避免每個 symbol 各查一次 list_positions 串行阻塞下單），
        就傳進來直接判斷；None 時才自己 strict 查倉。

        保護規則：
          1. 持倉商品不退訂 —— PnL 廣播依賴其 tick（回 False，保留在 _background_symbols）
          2. 當前 DOM 主商品（current_contract）不動串流 —— 只從 _background_symbols
             移除，之後主商品切走時 subscribe() 會照常取消訂閱（回 True）
          3. 不在背景清單的 symbol 視為 no-op（回 False）

        回傳 True 表示已退訂（或已從背景清單移除、交由主訂閱管理）。
        """
        contract = self.get_contract(symbol)
        if not contract:
            logger.warning(f"unsubscribe_background: 找不到合約 {symbol}")
            return False
        canonical = self.symbol_resolver.canonical(getattr(contract, "symbol", "")) or str(symbol).strip().upper()
        if canonical not in self._background_symbols:
            return False

        # 持倉商品：PnL 需要這條 tick 串流，絕不能退訂。
        # #12：用 strict 版 —— 查倉失敗會 raise（而非回 []），此時保守跳過退訂，
        # 不讓「查詢失敗」被當成「無倉」而錯誤退掉持倉商品的背景報價。
        # #13：呼叫端可先一次抓好持倉集合傳入（held_canonicals），避免逐 symbol 查。
        try:
            if held_canonicals is None:
                positions = self.list_positions_strict()
                held = {(p.get("symbol") or "") for p in positions}
            else:
                held = set(held_canonicals)
            if canonical in held:
                logger.info(f"unsubscribe_background 跳過 {canonical}：持倉中，PnL 需要背景報價")
                return False
        except Exception as e:
            logger.debug(f"unsubscribe_background 查持倉失敗（保守跳過退訂）: {e}")
            return False

        with self._subscribe_lock:
            self._background_symbols.discard(canonical)
            # 當前 DOM 交易中的主商品：串流由主訂閱持有，不能在這裡取消；
            # 已從背景清單移除，之後 subscribe() 切走時會照常 unsubscribe
            cur = self.current_contract
            if cur is not None and self.symbol_resolver.canonical(getattr(cur, "symbol", "")) == canonical:
                logger.info(f"unsubscribe_background {canonical}：為當前主商品，僅移出背景清單")
                return True
            try:
                self.api.quote.unsubscribe(contract, QuoteType.Tick)
                self.api.quote.unsubscribe(contract, QuoteType.BidAsk)
                logger.info(f"  ✅ 已退訂背景商品 {canonical} Tick+BidAsk")
            except Exception as e:
                logger.debug(f"unsubscribe_background {canonical} 取消訂閱例外: {e}")
        return True

    def place_order(self, symbol: str, price: float, action: Action, qty: int, order_type: OrderType = OrderType.ROD, price_type=None, order_lot=None, order_cond=None):
        contract = self.get_contract(symbol)
        if not contract:
            logger.warning(f"place_order: 找不到合約 {symbol}")
            return None
        account = self.active_stock_account if contract.security_type == 'STK' else self.active_futopt_account
        if not account:
            logger.warning(f"place_order: 沒有可用帳號 (security_type={contract.security_type})")
            return None
            
        # 決定預設 price_type
        if price_type is None:
            if contract.security_type == 'STK':
                price_type = StockPriceType.LMT if price > 0 else StockPriceType.MKT
            else:
                price_type = FuturesPriceType.LMT if price > 0 else FuturesPriceType.MKT

        # 組合參數
        order_kwargs = {
            "price": price if price > 0 else 0,
            "quantity": qty,
            "action": action,
            "price_type": price_type,
            "order_type": order_type,
            "account": account
        }
        
        # 股票專屬參數
        if contract.security_type == 'STK':
            order_kwargs["order_lot"] = order_lot or StockOrderLot.Common
            order_kwargs["order_cond"] = order_cond or StockOrderCond.Cash

        order = self.api.Order(**order_kwargs)
        try:
            return self.api.place_order(contract, order)
        except Exception as e:
            logger.error(f"place_order 失敗: {symbol} {action} {qty}@{price} — {e}")
            return None

    def search_contracts(self, query: str, limit: int = 20) -> List[Dict[str, str]]:
        """
        模糊搜尋商品代碼或名稱（不區分大小寫）。
        範圍：Stocks（含上市櫃）+ Futures + Options。
        """
        q = (query or "").strip().upper()
        if not q:
            return []
        out: List[Dict[str, str]] = []

        def _match(c, kind: str) -> bool:
            sym = str(getattr(c, "symbol", "") or "").upper()
            code = str(getattr(c, "code", "") or "").upper()
            name = str(getattr(c, "name", "") or "")
            return (q in sym) or (q in code) or (q in name.upper())

        def _emit(c, kind: str):
            if len(out) >= limit:
                return False
            out.append({
                "symbol": getattr(c, "symbol", ""),
                "code":   getattr(c, "code", ""),
                "name":   getattr(c, "name", ""),
                "kind":   kind,
            })
            return True

        # 嘗試直接以代碼取得股票合約以獲得精確名稱
        clean_q = q.replace("TSE", "").replace("OTC", "")
        if clean_q.isdigit():
            try:
                c = self.api.Contracts.Stocks.get(clean_q)
                if c and getattr(c, "symbol", ""):
                    _emit(c, "Stock")
            except Exception as e:
                logger.debug(f"精確尋找股票 {clean_q} 失敗: {e}")

        try:
            # Stocks: iter 直接拿到 contracts
            for c in self.api.Contracts.Stocks:
                if _match(c, "Stock") and not _emit(c, "Stock"):
                    return out
        except Exception as e:
            logger.debug(f"search Stocks 失敗: {e}")

        try:
            for attr in dir(self.api.Contracts.Futures):
                if attr.startswith("_"):
                    continue
                cat = getattr(self.api.Contracts.Futures, attr)
                if not hasattr(cat, "__iter__"):
                    continue
                for c in cat:
                    if _match(c, "Future") and not _emit(c, "Future"):
                        return out
        except Exception as e:
            logger.debug(f"search Futures 失敗: {e}")

        try:
            for attr in dir(self.api.Contracts.Options):
                if attr.startswith("_"):
                    continue
                cat = getattr(self.api.Contracts.Options, attr)
                if not hasattr(cat, "__iter__"):
                    continue
                for c in cat:
                    if _match(c, "Option") and not _emit(c, "Option"):
                        return out
        except Exception as e:
            logger.debug(f"search Options 失敗: {e}")

        return out

    def get_all_accounts(self) -> List[Dict[str, str]]:
        try:
            raw_accounts = self.api.list_accounts()
            return [
                {
                    "account_id": acc.account_id,
                    "category": (
                        "Stock"  if "Stock"  in acc.__class__.__name__ else
                        "Option" if "Option" in acc.__class__.__name__ else
                        "Future" if "Future" in acc.__class__.__name__ else
                        "Other"
                    ),
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
            # ★ 關鍵修復：從外部平台下單時，本地的 list_trades 不會自動更新
            # 必須先呼叫 update_status 強制向交易所/券商同步最新狀態
            self.update_status()
            return self.api.list_trades()
        except Exception as e:
            logger.error(f"get_order_history 失敗: {e}")
            return []

    def get_kbars(self, symbol: str, days: int = 1) -> List[Dict[str, Any]]:
        """
        Sprint 11：抓 1 分鐘 K 棒。days 指回看的「市場日」數，預設只給今日。
        回傳 [{time, open, high, low, close, volume}, ...]  time = unix 秒。
        """
        from datetime import datetime, timedelta
        contract = self.get_contract(symbol)
        if not contract:
            logger.warning(f"get_kbars: 找不到合約 {symbol}")
            return []
        try:
            end = datetime.now()
            start = (end - timedelta(days=max(1, days))).strftime("%Y-%m-%d")
            end_s = end.strftime("%Y-%m-%d")
            kb = self.api.kbars(contract, start=start, end=end_s)
            # Shioaji Kbars 物件：ts / Open / High / Low / Close / Volume，
            # ts 為 nanoseconds since epoch（int64）。轉成秒以利前端 lightweight-charts
            n = len(kb.ts)
            out: List[Dict[str, Any]] = []
            for i in range(n):
                out.append({
                    "time": int(kb.ts[i] // 1_000_000_000),
                    "open":  float(kb.Open[i]),
                    "high":  float(kb.High[i]),
                    "low":   float(kb.Low[i]),
                    "close": float(kb.Close[i]),
                    "volume": int(kb.Volume[i]),
                })
            return out
        except Exception as e:
            logger.error(f"get_kbars {symbol} 失敗: {e}", exc_info=True)
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
        """改單：找到符合的委託並修改價格或減量
        
        Shioaji API 正確用法:
          改價: api.update_order(trade=trade, price=new_price)
          減量: api.update_order(trade=trade, qty=new_qty)
        """
        try:
            trades = self.api.list_trades()
            for trade in trades:
                if (trade.contract.symbol == symbol and
                    trade.order.action == action and
                    float(trade.order.price) == old_price and
                    trade.status.status.name in ['PendingSubmit', 'PreSubmitted', 'Submitted']):
                    
                    # 依據是否改價/減量，選擇適當的 API 呼叫
                    price_changed = abs(new_price - old_price) > 0.001
                    qty_changed = qty is not None and qty != trade.order.quantity
                    
                    if price_changed and qty_changed:
                        # 同時改價與減量：先改價，再減量
                        self.api.update_order(trade=trade, price=new_price)
                        time.sleep(0.2)
                        self.api.update_order(trade=trade, qty=qty)
                        logger.info(f"改單(價+量)成功: {symbol} price {old_price} -> {new_price}, qty -> {qty}")
                    elif price_changed:
                        self.api.update_order(trade=trade, price=new_price)
                        logger.info(f"改價成功: {symbol} {old_price} -> {new_price}")
                    elif qty_changed:
                        self.api.update_order(trade=trade, qty=qty)
                        logger.info(f"減量成功: {symbol} qty -> {qty}")
                    else:
                        logger.warning(f"update_order: 價格與數量均無變更，跳過")
                        return False
                    
                    threading.Timer(0.5, self.trigger_account_update).start()
                    return True
            logger.warning(f"update_order: 找不到符合的委託 {symbol} {action} @{old_price}")
            return False
        except Exception as e:
            logger.error(f"update_order 失敗: {e}")
            return False

    def cancel_order_by_ids(self, order_ids) -> bool:
        """
        依委託單號（id / seqno / ordno 任一）撤掉「一張」活躍委託。
        CHASE 追價單 cancel-replace 專用：比 cancel_orders_by_action_price
        精準（不會誤殺同價位的其他委託）。

        回傳 True = 已送出撤單；False = 找不到活躍的對應委託
        （可能已全成 / 已被撤 —— 呼叫端交給成交/對帳路徑收尾）。
        """
        ids = {str(i) for i in (order_ids or []) if i}
        if not ids:
            return False
        try:
            trades = self.api.list_trades()
            for trade in trades:
                order = getattr(trade, "order", None)
                candidates = {str(getattr(order, a, "") or "")
                              for a in ("id", "seqno", "ordno")}
                candidates.discard("")
                if not (candidates & ids):
                    continue
                status_name = (trade.status.status.name if hasattr(trade.status, "status")
                               else getattr(trade.status, "name", ""))
                if status_name in ("PendingSubmit", "PreSubmitted", "Submitted", "PartFilled"):
                    self.api.cancel_order(trade)
                    logger.info(f"cancel_order_by_ids: 已撤單 {sorted(candidates & ids)}")
                    threading.Timer(0.5, self.trigger_account_update).start()
                    return True
                logger.info(f"cancel_order_by_ids: 委託 {sorted(candidates & ids)} "
                            f"已非活躍狀態（{status_name}），不撤")
                return False
            logger.warning(f"cancel_order_by_ids: 找不到委託 {sorted(ids)}")
            return False
        except Exception as e:
            logger.error(f"cancel_order_by_ids 失敗: {e}")
            return False

    def confirm_order_cancelled(self, order_ids, timeout_s: float = 1.0,
                                poll_interval_s: float = 0.1):
        """
        P0-1：CHASE cancel-replace 專用 —— 確認一張委託已離開活躍集合，
        並回報其「實際累計成交量」。撤單非同步：舊單可能在撤單在途時於
        交易所端部分/全部成交，必須先確認終態再以實際剩量掛新單，否則超額。

        在 order executor 執行緒上呼叫（阻塞輪詢 OK，不在行情執行緒）。

        回傳：
          {"cancelled": True,  "filled_qty": n} = 已離開活躍集合（撤成/已成/消失）
          {"cancelled": False, "filled_qty": n} = 逾時仍活躍（呼叫端本輪放棄）
          None                                   = 查詢失敗（呼叫端本輪放棄）
        """
        ids = {str(i) for i in (order_ids or []) if i}
        if not ids:
            return {"cancelled": True, "filled_qty": 0}
        deadline = time.time() + max(timeout_s, 0.0)
        last_filled = 0
        active = {"PendingSubmit", "PreSubmitted", "Submitted", "PartFilled"}
        while True:
            try:
                for acc in self.api.list_accounts():
                    try:
                        self.api.update_status(acc)
                    except Exception:
                        pass
                trades = self.api.list_trades()
            except Exception as e:
                logger.warning(f"confirm_order_cancelled 查詢失敗: {e}")
                return None
            found = None
            for trade in trades or []:
                order = getattr(trade, "order", None)
                cands = {str(getattr(order, a, "") or "")
                         for a in ("id", "seqno", "ordno")}
                cands.discard("")
                if cands & ids:
                    found = trade
                    break
            if found is None:
                # 委託已不在清單 → 已離開活躍集合
                return {"cancelled": True, "filled_qty": last_filled}
            status_name = (found.status.status.name if hasattr(found.status, "status")
                           else getattr(found.status, "name", ""))
            filled = int(getattr(found.status, "deal_quantity",
                                 getattr(found.status, "filled_quantity", 0)) or 0)
            last_filled = max(last_filled, filled)
            if status_name not in active:
                # Cancelled / Filled / Failed → 撤單終態確認
                return {"cancelled": True, "filled_qty": last_filled}
            if time.time() >= deadline:
                return {"cancelled": False, "filled_qty": last_filled}
            time.sleep(poll_interval_s)

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
                threading.Timer(0.5, self.trigger_account_update).start()
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
                threading.Timer(0.5, self.trigger_account_update).start()
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

