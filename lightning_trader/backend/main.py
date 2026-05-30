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

    # 注入 SoundManager 的 emit 通道：把音效事件丟進 quote queue，由 quote_broadcaster 廣播
    def _push_sound(msg: dict) -> None:
        if shared.fastapi_loop:
            shared.fastapi_loop.call_soon_threadsafe(shared.quotes_to_broadcast.put_nowait, msg)
    if hasattr(shared.engine, "sound_manager"):
        shared.engine.sound_manager.set_emit_fn(_push_sound)

    broadcast_task = asyncio.create_task(quote_broadcaster())
    pnl_task = asyncio.create_task(pnl_broadcaster())

    async def _auto_login():
        # 給 2 秒讓使用者有機會主動登入（避免 race）
        await asyncio.sleep(2)
        # 已登入或正在登入：直接跳過
        if getattr(shared.shioaji_client, "_is_connected", False):
            logger.info("⏭️ 跳過自動登入：已登入")
            return
        if not (Config.API_KEY and Config.SECRET_KEY):
            return
        logger.info("🔑 偵測到 .env 憑證，嘗試自動登入 Shioaji...")
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

    async def _daily_risk_reset():
        """每日 04:00（台北時間）重置 RiskManager 日虧損計數器（盤後）。
        固定用 Asia/Taipei 避免 Docker container 預設 UTC 時觸發點偏移 8 小時。"""
        from datetime import datetime, timedelta
        try:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo("Asia/Taipei")
        except Exception:
            tz = None
        while True:
            now = datetime.now(tz) if tz else datetime.now()
            target = now.replace(hour=4, minute=0, second=0, microsecond=0)
            if target <= now:
                target += timedelta(days=1)
            try:
                await asyncio.sleep((target - now).total_seconds())
                rm = getattr(shared.engine, "risk_manager", None)
                if rm is not None:
                    rm.reset_daily()
                    rm.config.trading_enabled = True
                    logger.info("⏰ 每日 04:00 RiskManager 日虧損已重置")
                # 順便清掉 VWAP 與 Tape，準備新的交易日
                vw = getattr(shared.engine, "vwap_calculator", None)
                if vw is not None:
                    vw.reset_session()
                tr = getattr(shared.engine, "tape_recorder", None)
                if tr is not None:
                    tr.clear()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"daily_risk_reset 例外: {e}")
                await asyncio.sleep(60)

    daily_task = asyncio.create_task(_daily_risk_reset())

    yield

    for task in (login_task, broadcast_task, pnl_task, daily_task):
        task.cancel()
    for task in (login_task, broadcast_task, pnl_task, daily_task):
        try:
            await task
        except asyncio.CancelledError:
            pass


# ─── FastAPI App ────────────────────────────────────────────

app = FastAPI(title="LighTrade Backend API", version="2.0.0", lifespan=lifespan)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """
    統一錯誤 envelope：永遠回傳 { code, user_msg }。
    詳細 traceback 只進 log，不外洩。
    """
    logger.error(f"未處理的例外 @ {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(status_code=500, content={
        "detail": {
            "code": "INTERNAL_ERROR",
            "user_msg": "伺服器發生未預期錯誤，請稍後再試或聯絡管理員",
        }
    })


# ★ CORS 緊縮：僅允許本機 Vite dev server 與本機部署
_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]
_extra = os.environ.get("LIGHTRADE_ALLOWED_ORIGINS", "")
if _extra:
    _ALLOWED_ORIGINS.extend([o.strip() for o in _extra.split(",") if o.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 掛載路由模組
from backend.routers import orders, accounts, smart, user_settings, risk, health
from backend.routers import sizing, vwap, tape, sound
app.include_router(orders.router)
app.include_router(accounts.router)
app.include_router(smart.router)
app.include_router(user_settings.router)
app.include_router(risk.router)
app.include_router(health.router)
app.include_router(sizing.router)
app.include_router(vwap.router)
app.include_router(tape.router)
app.include_router(sound.router)


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
