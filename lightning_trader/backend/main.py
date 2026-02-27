import os
import sys
import threading
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
from PyQt5.QtCore import QCoreApplication
if not QCoreApplication.instance():
    qapp = QCoreApplication(sys.argv)

from core.shioaji_client import ShioajiClient
from core.config import Config
from shioaji.constant import Action, OrderType

app = FastAPI(title="LighTrade Backend API")

# 實例化 ShioajiClient
shioaji_client = ShioajiClient()

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
    success = shioaji_client.login(
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
                    success = shioaji_client.subscribe(msg["symbol"])
                    await websocket.send_text(json.dumps({
                        "status": "success" if success else "failed", 
                        "action": "subscribe", 
                        "symbol": msg["symbol"]
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

    trade = shioaji_client.place_order(
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

@app.post("/api/cancel_all")
async def cancel_all(req: CancelAllRequest):
    """
    接收刪單指令並透過 shioaji_client 刪除特定方向的未結案委託。
    """
    action_val = Action.Buy if req.action.lower() == "buy" else Action.Sell
    try:
        cancel_count = shioaji_client.cancel_all(req.symbol, action_val)
        return {"status": "success", "message": f"成功送出 {cancel_count} 筆刪單指令"}
    except Exception as e:
        logger.error(f"批次刪單失敗: {e}")
        raise HTTPException(status_code=500, detail="刪單過程遭遇錯誤")

@app.get("/api/positions")
async def get_positions():
    """獲取目前的持倉部位"""
    try:
        positions = shioaji_client.list_positions()
        # 將 Shioaji Position 物件轉成 JSON 格式
        pos_list = []
        for p in positions:
            # 判斷是期貨還是股票持倉
            is_stock = hasattr(p, 'cond')
            if is_stock:
                # 股票持倉
                direction = "Buy" if p.cond.name in ["Cash", "MarginTrading"] else "Sell"
                symbol = p.code
            else:
                # 期貨持倉
                direction = "Buy" if getattr(p, 'direction', Action.Buy) == Action.Buy else "Sell"
                symbol = getattr(p.contract, 'symbol', 'Unknown')
                
            pos_list.append({
                "symbol": symbol,
                "qty": getattr(p, 'quantity', 0) or getattr(p, 'real_quantity', 0), # 相容不同版本 API
                "direction": direction,
                "price": float(getattr(p, 'price', 0)),
                "pnl": float(getattr(p, 'pnl', 0))
            })
        return pos_list
    except Exception as e:
        logger.error(f"獲取持倉發生錯誤: {e}")
        return []

@app.get("/api/account_balance")
async def get_account_balance():
    """獲取帳戶餘額 (保證金)"""
    try:
        balance = shioaji_client.get_account_balance()
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
async def get_order_history():
    """獲取當日委託/成交紀錄"""
    try:
        trades = shioaji_client.get_order_history()
        trade_list = []
        for t in trades:
            trade_list.append({
                "time": format_datetime(t.status.update_time),
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

if __name__ == "__main__":
    def run_api():
        uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
        
    api_thread = threading.Thread(target=run_api, daemon=True)
    api_thread.start()
    
    sys.exit(qapp.exec_())
