import os
import sys
import threading
import concurrent.futures
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import json
import asyncio
import logging
from datetime import datetime

# 配置日誌記錄
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 確保能在 backend 目錄中正確 import core 模組
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# 初始化 PyQt5 的 QApplication (因為 shioaji_client.py 內含 QObject, pyqtSignal, QTimer)
from PyQt5.QtCore import QCoreApplication, QObject, pyqtSignal
if not QCoreApplication.instance():
    qapp = QCoreApplication(sys.argv)

from core.shioaji_client import ShioajiClient
from core.config import Config
from shioaji.constant import Action, OrderType

app = FastAPI(title="LighTrade Backend API", version="1.0.2")

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"未捕獲的例外錯誤: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"status": "error", "message": str(exc)}
    )

# 實例化 ShioajiClient
shioaji_client = ShioajiClient()

class QtWorker(QObject):
    """
    用於將任務派發到 Qt 主執行緒執行的 Worker。
    解決 FastAPI 在 Uvicorn worker thread 中直接呼叫 ShioajiClient (QObject) 導致的 Thread-Safety 問題。
    """
    execute_signal = pyqtSignal(object, object)

    def __init__(self):
        super().__init__()
        self.execute_signal.connect(self._execute)

    def _execute(self, func, future):
        try:
            res = func()
            future.set_result(res)
        except Exception as e:
            future.set_exception(e)

qt_worker = QtWorker()

async def run_in_qt_thread(func, *args, **kwargs):
    """
    非同步輔助函數：將同步函數 func 丟到 Qt 主執行緒中執行，並等待其完成。
    """
    loop = asyncio.get_running_loop()
    future = concurrent.futures.Future()
    # emit 訊號，Qt 事件迴圈會將其排入主執行緒執行
    qt_worker.execute_signal.emit(lambda: func(*args, **kwargs), future)
    return await loop.run_in_executor(None, future.result)

# 活躍的 WebSocket 連接
active_connections: list[WebSocket] = []

# 用於在 shioaji_client 的同步上下文和 FastAPI 的非同步上下文之間傳遞報價
quotes_to_broadcast: asyncio.Queue = asyncio.Queue()
fastapi_loop = None

def format_datetime(dt):
    """將 datetime 物件轉換為 ISO 字串，以便 JSON 序列化"""
    if hasattr(dt, 'isoformat'):
        return dt.isoformat()
    return str(dt)

def on_shioaji_quote(quote_data: dict):
    """
    從 ShioajiClient 接收 Tick/BidAsk 報價，並格式化後放入 asyncio 佇列。
    """
    try:
        # 轉換為標準字典並處理日期格式化
        q = quote_data.copy()
        
        # 判斷是 BidAsk 還是 Tick
        is_bidask = any(k in q for k in ['bid_price', 'ask_price', 'BidPrice', 'AskPrice'])
        
        if is_bidask:
            # 轉換為前端預期的格式 (大寫 Key)
            bidask_data = {
                "AskPrice": q.get('ask_price', q.get('AskPrice', [])),
                "AskVolume": q.get('ask_volume', q.get('AskVolume', [])),
                "BidPrice": q.get('bid_price', q.get('BidPrice', [])),
                "BidVolume": q.get('bid_volume', q.get('BidVolume', [])),
                "DiffBidVol": q.get('diff_bid_vol', q.get('DiffBidVol', [])),
                "DiffAskVol": q.get('diff_ask_vol', q.get('DiffAskVol', [])),
                "Time": format_datetime(q.get('datetime', q.get('Time', '')))
            }
            quote_item = {"type": "BidAsk", "data": bidask_data}
        else:
            # 處理 Tick
            tick_data = {
                "Price": q.get('close', q.get('Price', 0)),
                "Volume": q.get('volume', q.get('Volume', 0)),
                "Open": q.get('open', q.get('Open', 0)),
                "High": q.get('high', q.get('High', 0)),
                "Low": q.get('low', q.get('Low', 0)),
                "AvgPrice": q.get('avg_price', 0),
                "Reference": q.get('reference', q.get('Reference', 0)),
                "LimitUp": q.get('limit_up', q.get('LimitUp', 0)),
                "LimitDown": q.get('limit_down', q.get('LimitDown', 0)),
                "TickTime": format_datetime(q.get('datetime', q.get('Time', ''))),
                "Action": q.get('action', '')
            }
            quote_item = {"type": "Tick", "data": tick_data}

        # 使用 fastapi_loop 進行執行緒安全的操作
        if fastapi_loop:
            fastapi_loop.call_soon_threadsafe(quotes_to_broadcast.put_nowait, quote_item)
        else:
            # 備援：嘗試獲取當前 loop
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    loop.call_soon_threadsafe(quotes_to_broadcast.put_nowait, quote_item)
            except:
                pass
            
    except Exception as e:
        logger.error(f"處理 Shioaji 報價並放入佇列時發生錯誤: {e}")

def on_shioaji_account_update(summary_data: dict):
    """
    從 ShioajiClient 接收帳戶摘要 (持倉、損益等)，廣播給前端。
    """
    try:
        quote_item = {"type": "AccountUpdate", "data": summary_data}
        if fastapi_loop:
            fastapi_loop.call_soon_threadsafe(quotes_to_broadcast.put_nowait, quote_item)
    except Exception as e:
        logger.error(f"廣播帳戶更新時發生錯誤: {e}")

def on_shioaji_order_update(order_msg: dict):
    """
    從 ShioajiClient 接收訂單狀態更新訊息。
    """
    try:
        # 將 order_msg 包含在 WebSocket 廣播中
        msg_item = {"type": "OrderUpdate", "data": order_msg}
        if fastapi_loop:
            fastapi_loop.call_soon_threadsafe(quotes_to_broadcast.put_nowait, msg_item)
    except Exception as e:
        logger.error(f"廣播訂單狀態更新時發生錯誤: {e}")

def on_shioaji_trade_update(trade_data: dict):
    """
    從 ShioajiClient 接收交易(成交)或系統事件回報。
    """
    try:
        msg_item = {"type": "TradeUpdate", "data": trade_data}
        if fastapi_loop:
            fastapi_loop.call_soon_threadsafe(quotes_to_broadcast.put_nowait, msg_item)
    except Exception as e:
        logger.error(f"廣播交易回報時發生錯誤: {e}")

# 將 ShioajiClient 的報價與帳戶訊號連接到我們的橋接函數
shioaji_client.signal_quote_tick.connect(on_shioaji_quote)
shioaji_client.signal_quote_bidask.connect(on_shioaji_quote)
shioaji_client.signal_account_update.connect(on_shioaji_account_update)
shioaji_client.signal_order_update.connect(on_shioaji_order_update)
shioaji_client.signal_trade_update.connect(on_shioaji_trade_update)

# 設定 CORS 允許跨域請求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def quote_broadcaster():
    """
    從 ShioajiClient 的報價佇列中取出報價，並廣播給所有已連接的 WebSocket 客戶端。
    """
    global fastapi_loop
    fastapi_loop = asyncio.get_running_loop()
    logger.info("報價廣播器已啟動")
    
    while True:
        try:
            # get() 會阻塞直到有資料
            quote_data = await quotes_to_broadcast.get()
            if quote_data:
                message = json.dumps(quote_data)
                # 廣播給所有活躍的 WebSocket 連接
                for connection in list(active_connections):
                    try:
                        await connection.send_text(message)
                    except Exception as e:
                        if connection in active_connections:
                            active_connections.remove(connection)
                        logger.info(f"WebSocket 斷開，移除連線: {e}")
        except Exception as e:
            logger.error(f"報價廣播器循環發生錯誤: {e}")
            await asyncio.sleep(0.1)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(quote_broadcaster())

class LoginRequest(BaseModel):
    api_key: str
    secret_key: str
    simulation: bool = True
    ca_path: str = ""
    ca_passwd: str = ""

class PlaceOrderRequest(BaseModel):
    symbol: str
    price: float
    action: str  # "Buy" 或 "Sell"
    qty: int
    order_type: str = "ROD"

@app.post("/api/login")
async def login(req: LoginRequest):
    """
    接收 JSON 格式的登入資訊並透過 shioaji_client 登入。
    """
    Config.SIMULATION = req.simulation
    success = await run_in_qt_thread(
        shioaji_client.login,
        api_key=req.api_key, 
        secret_key=req.secret_key, 
        simulation=req.simulation,
        ca_path=req.ca_path,
        ca_passwd=req.ca_passwd
    )
    
    if success:
        return {"status": "success", "message": "登入成功"}
    else:
        raise HTTPException(status_code=400, detail="登入失敗，請檢查 API 參數或網路狀態。")

@app.websocket("/ws/quotes")
async def websocket_quotes(websocket: WebSocket):
    """
    WebSocket 通道：推送即時的 Tick/BidAsk 報價給前端 React。
    """
    await websocket.accept()
    active_connections.append(websocket)
    logger.info(f"新的 WebSocket 客戶端已連接, 當前連接數: {len(active_connections)}")
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("action") == "subscribe" and msg.get("symbol"):
                    actual_symbol = await run_in_qt_thread(shioaji_client.subscribe, msg["symbol"])
                    await websocket.send_text(json.dumps({
                        "status": "success" if actual_symbol else "failed", 
                        "action": "subscribe", 
                        "symbol": actual_symbol or msg["symbol"]
                    }))
            except json.JSONDecodeError:
                pass
                
    except WebSocketDisconnect:
        if websocket in active_connections:
            active_connections.remove(websocket)
        logger.info(f"WebSocket 客戶端已斷開, 當前連接數: {len(active_connections)}")
    except Exception as e:
        logger.error(f"WebSocket 連線錯誤: {e}")
        if websocket in active_connections:
            active_connections.remove(websocket)

@app.post("/api/place_order")
async def place_order(req: PlaceOrderRequest):
    """
    接收下單參數並透過 shioaji_client 轉發。
    """
    action_val = Action.Buy if req.action.lower() == "buy" else Action.Sell
    order_type_val = OrderType.ROD
    if req.order_type.upper() == "IOC":
        order_type_val = OrderType.IOC
    elif req.order_type.upper() == "FOK":
        order_type_val = OrderType.FOK

    trade = await run_in_qt_thread(
        shioaji_client.place_order,
        symbol=req.symbol,
        price=req.price,
        action=action_val,
        qty=req.qty,
        order_type=order_type_val
    )

    if trade:
        return {"status": "success", "message": "下單成功"}
    else:
        raise HTTPException(status_code=400, detail="下單失敗，請確認標的或庫存是否正確。")

class CancelAllRequest(BaseModel):
    symbol: str
    action: str  # "Buy" 或 "Sell"

class UpdateOrderRequest(BaseModel):
    symbol: str
    action: str
    old_price: float
    new_price: float
    qty: int = None

class SmartOrderRequest(BaseModel):
    symbol: str
    action: str
    qty: int
    stop_price: float = 0
    trailing_offset: float = 0

@app.post("/api/update_order")
async def update_order(req: UpdateOrderRequest):
    """
    接收改單指令。
    """
    action_val = Action.Buy if req.action.lower() == "buy" else Action.Sell
    success = await run_in_qt_thread(
        shioaji_client.update_order,
        symbol=req.symbol,
        action=action_val,
        old_price=req.old_price,
        new_price=req.new_price,
        qty=req.qty
    )
    if success:
        return {"status": "success", "message": "改單指令已送出"}
    else:
        raise HTTPException(status_code=400, detail="改單失敗，找不到對應的委託。")

@app.post("/api/add_smart_order")
async def add_smart_order(req: SmartOrderRequest):
    """
    新增智慧單 (本地監控)。
    """
    action_val = Action.Buy if req.action.lower() == "buy" else Action.Sell
    await run_in_qt_thread(
        shioaji_client.add_smart_order,
        symbol=req.symbol,
        action=action_val,
        qty=req.qty,
        stop_price=req.stop_price,
        trailing_offset=req.trailing_offset
    )
    return {"status": "success", "message": "智慧單已設定"}

@app.get("/api/volume_profile")
async def get_volume_profile(symbol: str):
    """
    獲取指定商品的價量累積數據。
    """
    profile = shioaji_client.volume_profile.get(symbol, {})
    return profile

@app.post("/api/cancel_all")
async def cancel_all(req: CancelAllRequest):
    """
    接收刪單指令並透過 shioaji_client 刪除特定方向的未結案委託。
    """
    action_val = Action.Buy if req.action.lower() == "buy" else Action.Sell
    try:
        cancel_count = await run_in_qt_thread(shioaji_client.cancel_all, req.symbol, action_val)
        return {"status": "success", "message": f"成功送出 {cancel_count} 筆刪單指令"}
    except Exception as e:
        logger.error(f"批次刪單失敗: {e}")
        raise HTTPException(status_code=500, detail="刪單過程遭遇錯誤")

class SymbolRequest(BaseModel):
    symbol: str

class AccountSwitchRequest(BaseModel):
    account_id: str

@app.post("/api/set_active_account")
async def set_active_account(req: AccountSwitchRequest):
    """切換活躍帳號"""
    success = await run_in_qt_thread(shioaji_client.set_active_account, req.account_id)
    if success:
        return {"status": "success", "message": f"帳號已切換"}
    else:
        raise HTTPException(status_code=400, detail="切換帳號失敗")

@app.post("/api/flatten")
async def flatten_position(req: SymbolRequest):
    """一鍵平倉"""
    success = await run_in_qt_thread(shioaji_client.flatten_position, req.symbol)
    if success:
        return {"status": "success", "message": "一鍵平倉指令已送出"}
    else:
        raise HTTPException(status_code=400, detail="一鍵平倉失敗")

@app.post("/api/reverse")
async def reverse_position(req: SymbolRequest):
    """一鍵反向"""
    success = await run_in_qt_thread(shioaji_client.reverse_position, req.symbol)
    if success:
        return {"status": "success", "message": "一鍵反向指令已送出"}
    else:
        raise HTTPException(status_code=400, detail="一鍵反向失敗")

@app.get("/api/positions")
async def get_positions(account_id: str = None):
    """獲取目前的持倉部位"""
    try:
        results = await run_in_qt_thread(shioaji_client.list_positions)
        # 由於 shioaji_client.list_positions() 已經回傳格式化後的字典列表，直接回傳即可
        return results
    except Exception as e:
        logger.error(f"獲取持倉發生錯誤: {e}")
        return []

@app.get("/api/account_balance")
async def get_account_balance():
    """獲取帳戶餘額 (保證金)"""
    try:
        balance = await run_in_qt_thread(shioaji_client.get_account_balance)
        if balance:
            return {
                "equity": float(getattr(balance, 'equity', 0)),
                "margin_available": float(getattr(balance, 'margin_available', 0)),
                "margin_required": float(getattr(balance, 'margin_required', 0)),
                "pnl": float(getattr(balance, 'pnl', 0))
            }
        return {}
    except Exception as e:
        logger.error(f"獲取帳戶餘額發生錯誤: {e}")
        return {}

@app.get("/api/order_history")
async def get_order_history(account_id: str = None):
    """獲取當日委託/成交紀錄"""
    try:
        # TODO: 未來可進一步在 shioaji_client 內實現 account_id 過濾 trades
        trades = await run_in_qt_thread(shioaji_client.get_order_history)
        trade_list = []
        for t in trades:
            # 支援篩選功能（如果傳入則過濾）
            if account_id and t.order.account.account_id != account_id:
                continue
                
            trade_list.append({
                "time": format_datetime(getattr(t.status, 'modified_at', datetime.now())),
                "symbol": t.contract.symbol,
                "action": "Buy" if t.order.action == Action.Buy else "Sell",
                "price": float(t.order.price),
                "qty": t.order.quantity,
                "status": t.status.status.name,
                "filled_qty": t.status.filled_quantity,
                "filled_avg_price": float(t.status.filled_avg_price)
            })
        # 依照時間反序排序 (最新在前面)
        trade_list.sort(key=lambda x: x['time'], reverse=True)
        return trade_list
    except Exception as e:
        logger.error(f"獲取委託歷史發生錯誤: {e}")
        return []

@app.get("/api/accounts")
async def get_accounts():
    """獲取所有可用帳號資訊"""
    try:
        return await run_in_qt_thread(shioaji_client.get_all_accounts)
    except Exception as e:
        logger.error(f"獲取帳號列表失敗: {e}")
        return []

if __name__ == "__main__":
    def run_api():
        uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
        
    api_thread = threading.Thread(target=run_api, daemon=True)
    api_thread.start()
    
    sys.exit(qapp.exec_())
