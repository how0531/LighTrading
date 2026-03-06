"""
main.py — LighTrade 後端入口

職責：
1. 初始化 QCoreApplication + TradingEngine
2. 設定 FastAPI app + CORS + lifespan（背景任務）
3. 掛載 routers
4. WebSocket /ws/quotes（唯一留在此處的端點）
5. 啟動 uvicorn
"""
import os
import sys
import threading
import json
import asyncio
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import uvicorn

# 配置日誌記錄
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 確保能在 backend 目錄中正確 import core 模組
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# 初始化交易引擎
from core import create_trading_engine
from core.config import Config

# 匯入共用狀態模組並初始化
from backend import shared
from backend.bridge import wire_callbacks
from backend.services.quote_broadcaster import quote_broadcaster
from backend.services.pnl_broadcaster import pnl_broadcaster, subscribe_position_contracts

# 建立引擎 & 設定共用狀態
engine = create_trading_engine()
shared.engine = engine
shared.shioaji_client = engine.client

# 連接所有 Shioaji 回呼
wire_callbacks()


# ─── Lifespan ──────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app):
    """FastAPI lifespan: 啟動/關閉背景任務"""
    shared.fastapi_loop = asyncio.get_running_loop()

    broadcast_task = asyncio.create_task(quote_broadcaster())
    pnl_task = asyncio.create_task(pnl_broadcaster())

    async def _auto_login():
        await asyncio.sleep(2)
        if Config.API_KEY and Config.SECRET_KEY:
            logger.info("🔑 偵測到 .env 憑證，自動登入 Shioaji...")
            try:
                success = await shared.run_in_qt_thread(shared.shioaji_client.login)
                if success:
                    logger.info("✅ Shioaji 自動登入成功")
                    await asyncio.sleep(1)
                    await subscribe_position_contracts()
                else:
                    logger.warning("⚠️ Shioaji 自動登入失敗，請檢查 .env 設定")
            except Exception as e:
                logger.error(f"❌ 自動登入發生例外: {e}")

    login_task = asyncio.create_task(_auto_login())

    yield

    for task in (login_task, broadcast_task, pnl_task):
        task.cancel()
    for task in (login_task, broadcast_task, pnl_task):
        try:
            await task
        except asyncio.CancelledError:
            pass


# ─── FastAPI App ────────────────────────────────────────────

app = FastAPI(title="LighTrade Backend API", version="2.0.0", lifespan=lifespan)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"未處理的例外: {exc}", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": str(exc)})

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 掛載路由模組
from backend.routers import orders, accounts, smart
app.include_router(orders.router)
app.include_router(accounts.router)
app.include_router(smart.router)


# ─── WebSocket（唯一留在 main 的端點）─────────────────────

@app.websocket("/ws/quotes")
async def websocket_quotes(websocket: WebSocket):
    """WebSocket 通道：推送即時報價給前端"""
    await websocket.accept()
    shared.active_connections.add(websocket)
    logger.info(f"新的 WebSocket 客戶端已連接, 當前連接數: {len(shared.active_connections)}")
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("action") == "subscribe" and msg.get("symbol"):
                    actual_symbol = msg["symbol"]

                    if not shared.shioaji_client._is_connected:
                        await websocket.send_text(json.dumps({
                            "status": "error",
                            "action": "subscribe",
                            "symbol": actual_symbol,
                            "message": "請先使用真實 Shioaji API 金鑰登入後再訂閱報價"
                        }))
                        continue

                    try:
                        res = await shared.run_in_qt_thread(shared.shioaji_client.subscribe, msg["symbol"])
                        if res:
                            actual_symbol = res
                    except Exception as e:
                        logger.warning(f"WebSocket 訂閱遇到例外: {e}")

                    await websocket.send_text(json.dumps({
                        "status": "success",
                        "action": "subscribe",
                        "symbol": actual_symbol
                    }))
            except json.JSONDecodeError:
                pass

    except WebSocketDisconnect:
        shared.active_connections.discard(websocket)
        logger.info(f"WebSocket 客戶端已斷開, 當前連接數: {len(shared.active_connections)}")
    except Exception as e:
        logger.error(f"WebSocket 連線錯誤: {e}")
        shared.active_connections.discard(websocket)


# ─── 主程式入口 ──────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
