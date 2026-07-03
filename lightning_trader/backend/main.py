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
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import uvicorn


def _setup_logging() -> None:
    """
    Sprint 21 (BACKLOG B8)：每日輪替的 backend log。
    - file: ~/.lightrade/logs/backend.log，midnight 輪替，保留 14 天
    - 同時保留 stderr console handler（給 dev / Electron sidecar stdout 鏡像）
    - 環境變數 LIGHTRADE_LOG_DIR 覆寫資料夾；空字串 = 不啟用 file handler（測試友好）
    """
    fmt = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)

    # 先清掉 basicConfig 預設加的 handler，避免重複輸出
    for h in list(root.handlers):
        root.removeHandler(h)

    # Console handler（stderr）—— 永遠保留
    ch = logging.StreamHandler()
    ch.setFormatter(fmt)
    ch.setLevel(logging.INFO)
    root.addHandler(ch)

    # File handler（輪替）
    log_dir_raw = os.environ.get("LIGHTRADE_LOG_DIR")
    if log_dir_raw == "":
        return  # 顯式空字串 = 跳過 file handler
    log_dir = Path(log_dir_raw) if log_dir_raw else (Path.home() / ".lightrade" / "logs")
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        fh = TimedRotatingFileHandler(
            log_dir / "backend.log",
            when="midnight",
            interval=1,
            backupCount=14,
            encoding="utf-8",
            utc=False,
        )
        fh.setFormatter(fmt)
        fh.setLevel(logging.INFO)
        root.addHandler(fh)
    except Exception as e:
        # log dir 不可寫就 fallback 到純 console，不擋 backend 啟動
        root.warning(f"無法建立 file log handler 於 {log_dir}: {e}")


_setup_logging()
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

# ★ 智慧單觸發：注入「過風控的下單函數」+「丟到 broker thread 執行」
#   （之前觸發時直接在行情執行緒上同步下單，且完全繞過 RiskManager）
from backend.services.order_guard import smart_place_order
engine.smart_order_engine._place_order = smart_place_order
engine.smart_order_engine.set_dispatch(shared.submit_to_broker_thread)


# ─── Lifespan ──────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app):
    """FastAPI lifespan: 啟動/關閉背景任務"""
    shared.fastapi_loop = asyncio.get_running_loop()

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
        # ★ LIVE 帳戶不做無人確認的自動登入：需明確設 LIGHTRADE_ALLOW_LIVE_AUTOLOGIN=true
        if not Config.SIMULATION and os.environ.get(
                "LIGHTRADE_ALLOW_LIVE_AUTOLOGIN", "").lower() not in ("1", "true", "yes"):
            logger.warning(
                "⚠️ 偵測到 LIVE (SIMULATION=false) 憑證，但未設 LIGHTRADE_ALLOW_LIVE_AUTOLOGIN=true，"
                "跳過自動登入。請從前端登入頁手動登入，或設定該環境變數。")
            return
        logger.info("🔑 偵測到 .env 憑證，嘗試自動登入 Shioaji...")
        try:
            success = await shared.run_in_broker_thread(shared.shioaji_client.login)
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
        """每日 04:00 重置 RiskManager 日虧損計數器（盤後）。"""
        from datetime import datetime, timedelta
        while True:
            now = datetime.now()
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


# ─── API Token 認證（可選） ─────────────────────────────────
# 設定 LIGHTRADE_API_TOKEN 後：
#   - 所有 /api/*（除 /api/health）需帶 header `X-API-Token: <token>`
#   - /ws/quotes 需帶 query `?token=<token>`
# 未設定時維持現狀（純本機單人使用）。CORS 只能約束瀏覽器，
# 不是伺服器端存取控制 —— 綁非 127.0.0.1（Docker/LAN）時強烈建議設定。
import secrets as _secrets

_API_TOKEN = os.environ.get("LIGHTRADE_API_TOKEN", "").strip()


def _token_ok(provided: str) -> bool:
    return bool(provided) and _secrets.compare_digest(provided, _API_TOKEN)


if _API_TOKEN:
    @app.middleware("http")
    async def _api_token_auth(request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/") and path != "/api/health":
            if not _token_ok(request.headers.get("X-API-Token", "")):
                return JSONResponse(status_code=401, content={
                    "detail": {
                        "code": "UNAUTHORIZED",
                        "user_msg": "缺少或錯誤的 API Token（X-API-Token）",
                    }
                })
        return await call_next(request)

    logger.info("🔐 API Token 認證已啟用（LIGHTRADE_API_TOKEN）")
else:
    logger.info("ℹ️ 未設定 LIGHTRADE_API_TOKEN — API 無認證，僅適合純本機使用")


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
from backend.routers import orders, accounts, smart, user_settings, risk, health, reports, journal
app.include_router(orders.router)
app.include_router(accounts.router)
app.include_router(smart.router)
app.include_router(user_settings.router)
app.include_router(risk.router)
app.include_router(health.router)
app.include_router(reports.router)
app.include_router(journal.router)


# ─── Frontend Static Serving (same-origin for Electron) ─────
# 生產（打包）優先讀 LIGHTRADE_FRONTEND_DIST；開發回退到 ../frontend/dist
_static_dir_env = os.environ.get("LIGHTRADE_FRONTEND_DIST")
if _static_dir_env:
    _static_dir = os.path.abspath(_static_dir_env)
else:
    _static_dir = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
    )

if os.path.isdir(_static_dir):
    _assets_dir = os.path.join(_static_dir, "assets")
    if os.path.isdir(_assets_dir):
        # Vite 產生的雜湊化資產
        app.mount(
            "/assets",
            StaticFiles(directory=_assets_dir),
            name="assets",
        )
    _index_html = os.path.join(_static_dir, "index.html")
    logger.info(f"📦 已啟用前端靜態服務：{_static_dir}")

    # 已知靜態副檔名 —— 找不到就回真實 404，不要 fallback 到 index.html
    _STATIC_EXTS = (
        ".js", ".css", ".map", ".ico", ".png", ".jpg", ".jpeg", ".gif",
        ".svg", ".webp", ".woff", ".woff2", ".ttf", ".eot", ".json",
        ".txt", ".wasm",
    )

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        """SPA fallback：非 API/WS 路徑回傳 index.html，讓 React Router 處理。"""
        # 不攔截 api/ ws/ —— 讓對應 router 自行 404
        if full_path.startswith("api/") or full_path.startswith("ws/"):
            raise HTTPException(status_code=404, detail="Not Found")

        # 直接命中根目錄檔案（例如 favicon.ico, robots.txt）
        candidate = os.path.join(_static_dir, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)

        # 已知靜態副檔名但找不到 —— 回真實 404
        lower = full_path.lower()
        if lower.endswith(_STATIC_EXTS):
            raise HTTPException(status_code=404, detail="Not Found")

        # 其餘交給 React Router
        if os.path.isfile(_index_html):
            return FileResponse(_index_html)
        raise HTTPException(status_code=404, detail="Not Found")
else:
    logger.info(f"ℹ️ 未找到前端 dist 目錄（{_static_dir}），略過靜態掛載")


# ─── WebSocket（唯一留在 main 的端點）─────────────────────

@app.websocket("/ws/quotes")
async def websocket_quotes(websocket: WebSocket):
    """WebSocket 通道：推送即時報價給前端"""
    # Token 認證（與 /api 一致）；4401 = 自訂「未授權」關閉碼
    if _API_TOKEN and not _token_ok(websocket.query_params.get("token", "")):
        await websocket.close(code=4401, reason="unauthorized")
        return
    await websocket.accept()
    shared.active_connections.add(websocket)
    logger.info(f"新的 WebSocket 客戶端已連接, 當前連接數: {len(shared.active_connections)}")
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                action = msg.get("action")
                if action == "subscribe" and msg.get("symbol"):
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
                        res = await shared.run_in_broker_thread(shared.shioaji_client.subscribe, msg["symbol"])
                        if res:
                            actual_symbol = res
                    except Exception as e:
                        logger.warning(f"WebSocket 訂閱遇到例外: {e}")

                    await websocket.send_text(json.dumps({
                        "status": "success",
                        "action": "subscribe",
                        "symbol": actual_symbol
                    }))
                elif action == "watch" and isinstance(msg.get("symbols"), list):
                    # Sprint 12：watchlist — 用 subscribe_background 訂閱所有 symbols
                    # 不切換 current_contract，背景流會把 Tick 也丟給這個 WS 連線
                    if not shared.shioaji_client._is_connected:
                        # 回 error ack 讓前端能 retry（之前是靜默 ignore，登入競態時 user 看不到報價）
                        await websocket.send_text(json.dumps({
                            "status": "error",
                            "action": "watch",
                            "message": "尚未登入，請稍後再試",
                        }))
                        continue
                    syms = [s for s in msg["symbols"] if isinstance(s, str) and s.strip()]
                    accepted = []
                    rejected = []
                    for s in syms[:30]:   # 上限 30 個避免訂太多
                        try:
                            ok = await shared.run_in_broker_thread(shared.shioaji_client.subscribe_background, s)
                            (accepted if ok else rejected).append(s.upper())
                        except Exception as e:
                            logger.warning(f"watch 背景訂閱 {s} 失敗: {e}")
                            rejected.append(s.upper())
                    # 超過 30 的也視為 rejected，讓前端能提示
                    if len(syms) > 30:
                        rejected.extend(s.upper() for s in syms[30:])
                    await websocket.send_text(json.dumps({
                        "status": "success",
                        "action": "watch",
                        "symbols": accepted,
                        "rejected": rejected,
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
    _host = os.environ.get("LIGHTRADE_HOST", "127.0.0.1")
    try:
        _port = int(os.environ.get("LIGHTRADE_PORT", "8000"))
    except ValueError:
        _port = 8000
    uvicorn.run(app, host=_host, port=_port, log_level="info")
