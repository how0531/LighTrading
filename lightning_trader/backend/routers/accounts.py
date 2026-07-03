"""
routers/accounts.py — 帳務相關 API 路由

包含：登入、帳號切換、持倉查詢、帳戶餘額、委託歷史
"""
import asyncio
import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from shioaji.constant import Action
from core.config import Config
from backend import shared
from backend.rate_limit import check_rate_limit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["accounts"])


# ─── Request Models ────────────────────────────────────────

class LoginRequest(BaseModel):
    # 允許前端不傳金鑰；若空字串則改用 backend .env 的 Config.API_KEY/SECRET_KEY
    api_key: str = ""
    secret_key: str = ""
    simulation: bool = True
    ca_path: str = ""
    ca_passwd: str = ""


def _mask(s: str, head: int = 2, tail: int = 2) -> str:
    """字串遮蔽工具，給 log 用。"""
    if not s:
        return ""
    s = str(s)
    if len(s) <= head + tail:
        return "*" * len(s)
    return f"{s[:head]}{'*' * (len(s) - head - tail)}{s[-tail:]}"

class AccountSwitchRequest(BaseModel):
    account_id: str


# ─── 路由端點 ──────────────────────────────────────────────

@router.post("/login")
async def login(req: LoginRequest, request: Request):
    """
    登入流程：
      1. 若 simulation=False 但前端沒給 api_key/secret_key，改用 backend .env
      2. 已登入則直接返回 success（不重複登入）
      3. 金鑰只進 logger.debug 並遮蔽；info/error 永不夾帶 raw 金鑰
    """
    check_rate_limit(request)
    # 若已登入，直接回成功，避免重複呼叫造成 socket flapping
    if getattr(shared.shioaji_client, "_is_connected", False) and shared.shioaji_client.is_simulation == req.simulation:
        return {"status": "success", "message": "已登入", "already": True}

    Config.SIMULATION = req.simulation
    api_key = req.api_key or Config.API_KEY or ""
    secret_key = req.secret_key or Config.SECRET_KEY or ""

    if not api_key or not secret_key:
        raise HTTPException(status_code=400, detail={
            "code": "MISSING_CREDENTIALS",
            "user_msg": "未提供 API Key / Secret，且 .env 也沒有預設值",
        })

    logger.info(
        "嘗試登入 Shioaji：simulation=%s, api_key=%s, ca_path=%s",
        req.simulation, _mask(api_key, 3, 3), _mask(req.ca_path, 6, 4) if req.ca_path else "(none)"
    )

    try:
        success = await shared.run_in_broker_thread(
            shared.shioaji_client.login,
            api_key=api_key, secret_key=secret_key,
            simulation=req.simulation,
            ca_path=req.ca_path, ca_passwd=req.ca_passwd
        )
    except Exception as e:
        logger.error("Shioaji login 例外: %s", e, exc_info=True)
        raise HTTPException(status_code=400, detail={
            "code": "LOGIN_EXCEPTION",
            "user_msg": "登入過程發生錯誤，請確認網路與憑證",
        })

    if success:
        from backend.services.pnl_broadcaster import subscribe_position_contracts
        asyncio.create_task(subscribe_position_contracts())
        return {"status": "success", "message": "登入成功"}
    else:
        raise HTTPException(status_code=400, detail={
            "code": "LOGIN_FAILED",
            "user_msg": "登入失敗：請確認 API Key、Secret 或 CA 設定是否正確",
        })


@router.post("/set_active_account")
async def set_active_account(req: AccountSwitchRequest):
    """切換活躍帳號"""
    success = await shared.run_in_broker_thread(shared.shioaji_client.set_active_account, req.account_id)
    if success:
        return {"status": "success", "message": f"帳號已切換"}
    else:
        raise HTTPException(status_code=400, detail="切換帳號失敗")


@router.get("/positions")
async def get_positions(account_id: str = None):
    """獲取目前的持倉部位，支援依 account_id 篩選"""
    try:
        results = await shared.run_in_broker_thread(shared.shioaji_client.list_positions)
        if account_id:
            results = [p for p in results if p.get("account", "") == account_id]
        return results
    except Exception as e:
        logger.error(f"獲取持倉發生錯誤: {e}")
        return []


@router.get("/account_balance")
async def get_account_balance():
    """獲取帳戶餘額 (保證金)"""
    try:
        balance = await shared.run_in_broker_thread(shared.shioaji_client.get_account_balance)
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


@router.get("/order_history")
async def get_order_history(account_id: str = None):
    """獲取當日委託/成交紀錄"""
    try:
        try:
            await shared.run_in_broker_thread(shared.shioaji_client.api.update_status)
        except Exception:
            pass

        trades = await shared.run_in_broker_thread(shared.shioaji_client.get_order_history)
        trade_list = []

        if trades and logger.isEnabledFor(logging.DEBUG):
            t0 = trades[0]
            logger.debug(f"trade[0].status attrs: {[a for a in dir(t0.status) if not a.startswith('_')]}")

        for t in trades:
            if account_id and t.order.account.account_id != account_id:
                continue

            raw_symbol = getattr(t.contract, 'symbol', '')
            if not raw_symbol:
                raw_symbol = getattr(t.contract, 'code', '')

            deals = getattr(t.status, 'deals', [])
            calc_avg_price = 0.0
            if deals and isinstance(deals, list) and len(deals) > 0:
                total_val = sum(getattr(d, 'price', 0) * getattr(d, 'quantity', 0) for d in deals)
                total_q = sum(getattr(d, 'quantity', 0) for d in deals)
                if total_q > 0:
                    calc_avg_price = total_val / total_q

            trade_list.append({
                "time": shared.format_datetime(getattr(t.status, 'modified_at', datetime.now())),
                "symbol": raw_symbol,
                "action": "Buy" if t.order.action == Action.Buy else "Sell",
                "price": float(t.order.price),
                "qty": t.order.quantity,
                "status": t.status.status.name if hasattr(t.status, 'status') else getattr(t.status, 'name', 'Unknown'),
                "failed_msg": getattr(t.status, 'msg', getattr(t.status, 'details', '')),
                "filled_qty": getattr(t.status, 'deal_quantity', getattr(t.status, 'filled_quantity', 0)),
                "filled_avg_price": float(
                    calc_avg_price or
                    shared.shioaji_client._deal_prices.get(
                        getattr(t.order, 'ordno', '') or getattr(t.order, 'seqno', ''),
                        getattr(t.status, 'deal_price', getattr(t.status, 'filled_avg_price', 0)) or 0
                    )
                )
            })
        trade_list.sort(key=lambda x: x['time'], reverse=True)
        return {"seq_no": shared.generate_order_seq(), "orders": trade_list}
    except Exception as e:
        logger.error(f"獲取委託歷史發生錯誤: {e}")
        return {"seq_no": shared.generate_order_seq(), "orders": []}


@router.get("/accounts")
async def get_accounts():
    """獲取所有可用帳號資訊"""
    try:
        return await shared.run_in_broker_thread(shared.shioaji_client.get_all_accounts)
    except Exception as e:
        logger.error(f"獲取帳號列表失敗: {e}")
        return []


@router.get("/kbars")
async def get_kbars(symbol: str, days: int = 1):
    """
    Sprint 11：拿指定商品的 1 分鐘 K 棒。days 預設 1 = 今日。
    若還沒登入或沒料就回空 array，前端要能 graceful 處理。
    """
    if not getattr(shared.shioaji_client, "_is_connected", False):
        return []
    sym = (symbol or "").strip().upper()
    if not sym:
        return []
    try:
        days = max(1, min(30, int(days)))   # 限制 1~30 日
        return await shared.run_in_broker_thread(shared.shioaji_client.get_kbars, sym, days)
    except Exception as e:
        logger.error(f"get_kbars endpoint 失敗: {e}")
        return []


# 離線常用股票中文名稱資料庫。
# 由於 Shioaji 有連線限制或偶爾斷線，為避免前端商品名稱因未連線成功而顯示為空白，
# 此處提供常見與預設持倉代碼的靜態對照，作為高可用性（HA）的 fallback 方案。
_OFFLINE_SYMBOLS = {
    "2890": {"name": "永豐金", "exchange": "TSE"},
    "6757": {"name": "台灣虎航", "exchange": "TSE"},
    "00910": {"name": "第一金太空衛星", "exchange": "TSE"},
    "2355": {"name": "敬鵬", "exchange": "TSE"},
    "5309": {"name": "系統電", "exchange": "OTC"},
    "2330": {"name": "台積電", "exchange": "TSE"},
    "2317": {"name": "鴻海", "exchange": "TSE"},
    "2454": {"name": "聯發科", "exchange": "TSE"},
    "2303": {"name": "聯電", "exchange": "TSE"},
    "2881": {"name": "富邦金", "exchange": "TSE"},
    "2882": {"name": "國泰金", "exchange": "TSE"},
    "2883": {"name": "開發金", "exchange": "TSE"},
    "2884": {"name": "玉山金", "exchange": "TSE"},
    "2885": {"name": "元大金", "exchange": "TSE"},
    "2886": {"name": "兆豐金", "exchange": "TSE"},
    "2887": {"name": "台新金", "exchange": "TSE"},
    "2888": {"name": "新光金", "exchange": "TSE"},
    "2891": {"name": "中信金", "exchange": "TSE"},
    "2892": {"name": "第一金", "exchange": "TSE"},
    "5880": {"name": "合庫金", "exchange": "TSE"},
}


@router.get("/symbols/search")
async def search_symbols(q: str, limit: int = 20):
    """模糊搜尋商品。query 至少 1 字。"""
    if not q or len(q.strip()) < 1:
        return []
    
    limit = max(1, min(50, int(limit)))
    q_clean = q.strip().upper().replace("TSE", "").replace("OTC", "")
    
    # 比對離線靜態資料庫
    offline_results = []
    for code, info in _OFFLINE_SYMBOLS.items():
        if q_clean in code or q_clean in info["name"]:
            offline_results.append({
                "symbol": f"{info['exchange']}{code}",
                "code": code,
                "name": info["name"],
                "kind": "Stock"
            })
            
    # 如果後端尚未與永豐金伺服器連線成功，則直接回傳離線配對結果，提供順暢的離線體驗
    if not getattr(shared.shioaji_client, "_is_connected", False):
        return offline_results[:limit]
        
    try:
        online_results = await shared.run_in_broker_thread(shared.shioaji_client.search_contracts, q.strip(), limit)
        if not isinstance(online_results, list):
            online_results = []
            
        # 為了保持回傳規格統一（Dict[str, str]），若回傳為 Contract 物件，將其轉為 dict
        # 並與離線資料庫做聯集 (Union)，確保常用的股票在線上搜尋回傳中也不會漏掉
        existing_symbols = set()
        formatted_online = []
        for item in online_results:
            if isinstance(item, dict) and "symbol" in item:
                sym_upper = item["symbol"].upper()
                existing_symbols.add(sym_upper)
                formatted_online.append(item)
            elif hasattr(item, "code") and hasattr(item, "name"):
                code = getattr(item, "code", "")
                exch = getattr(item, "exchange", "TSE")
                full_sym = f"{exch}{code}".upper()
                existing_symbols.add(full_sym)
                formatted_online.append({
                    "symbol": full_sym,
                    "code": code,
                    "name": getattr(item, "name", ""),
                    "kind": "Stock"
                })
                
        # 補充未在線上結果中出現的離線常用股票
        for item in offline_results:
            if item["symbol"].upper() not in existing_symbols:
                formatted_online.append(item)
                existing_symbols.add(item["symbol"].upper())
                
        return formatted_online[:limit]
    except Exception as e:
        logger.error(f"search_symbols 線上搜尋失敗，使用離線 Fallback: {e}")
        return offline_results[:limit]


@router.post("/sync_all")
async def sync_all():
    """
    強制三合一同步：update_status + list_trades + list_positions。
    給前端在 WebSocket 重連 / 使用者按「重新整理」時呼叫。

    回傳：
      - working_orders：當前活躍委託（含外部平台送出的單）
      - positions：最新持倉
      - seq_no（snapshot）
    """
    client = shared.shioaji_client
    if not getattr(client, "_is_connected", False):
        raise HTTPException(status_code=409, detail="尚未登入，無法同步")

    try:
        # 1. update_status：強制券商主機把外部 session 的單也同步回來
        await shared.run_in_broker_thread(client.api.update_status)
        # 2. list_trades → 活躍委託快照
        trades = await shared.run_in_broker_thread(client.get_order_history)
        active_statuses = {"PendingSubmit", "PreSubmitted", "Submitted", "PartFilled"}
        working = []
        from shioaji.constant import Action as _Action
        for t in trades:
            status_name = t.status.status.name if hasattr(t.status, "status") else getattr(t.status, "name", "Unknown")
            if status_name not in active_statuses:
                continue
            raw_symbol = getattr(t.contract, "symbol", "") or getattr(t.contract, "code", "")
            working.append({
                "symbol": raw_symbol,
                "action": "Buy" if t.order.action == _Action.Buy else "Sell",
                "price": float(t.order.price),
                "qty": t.order.quantity,
                "filled_qty": getattr(t.status, "deal_quantity", getattr(t.status, "filled_quantity", 0)),
                "status": status_name,
                "order_id": getattr(t.order, "id", getattr(t.order, "seqno", "")),
            })
        # 3. list_positions
        positions = await shared.run_in_broker_thread(client.list_positions)
        # 4. 觸發一次帳務廣播
        try:
            client.trigger_account_update()
        except Exception:
            pass
        return {
            "status": "success",
            "seq_no": shared.generate_snapshot_seq(),
            "working_orders": working,
            "positions": positions,
        }
    except Exception as e:
        logger.error(f"sync_all 失敗: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="同步失敗")
