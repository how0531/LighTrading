"""
routers/accounts.py — 帳務相關 API 路由

包含：登入、帳號切換、持倉查詢、帳戶餘額、委託歷史
"""
import asyncio
import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from shioaji.constant import Action
from core.config import Config
from backend import shared

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["accounts"])


# ─── Request Models ────────────────────────────────────────

class LoginRequest(BaseModel):
    api_key: str
    secret_key: str
    simulation: bool = True
    ca_path: str = ""
    ca_passwd: str = ""

class AccountSwitchRequest(BaseModel):
    account_id: str


# ─── 路由端點 ──────────────────────────────────────────────

@router.post("/login")
async def login(req: LoginRequest):
    """接收 JSON 格式的登入資訊並透過 shioaji_client 登入"""
    Config.SIMULATION = req.simulation

    success = await shared.run_in_qt_thread(
        shared.shioaji_client.login,
        api_key=req.api_key, secret_key=req.secret_key,
        simulation=req.simulation,
        ca_path=req.ca_path, ca_passwd=req.ca_passwd
    )

    if success:
        from backend.services.pnl_broadcaster import subscribe_position_contracts
        asyncio.create_task(subscribe_position_contracts())
        return {"status": "success", "message": "登入成功"}
    else:
        raise HTTPException(status_code=400, detail="登入失敗，請檢查 API 參數或網路狀態。")


@router.post("/set_active_account")
async def set_active_account(req: AccountSwitchRequest):
    """切換活躍帳號"""
    success = await shared.run_in_qt_thread(shared.shioaji_client.set_active_account, req.account_id)
    if success:
        return {"status": "success", "message": f"帳號已切換"}
    else:
        raise HTTPException(status_code=400, detail="切換帳號失敗")


@router.get("/positions")
async def get_positions(account_id: str = None):
    """獲取目前的持倉部位，支援依 account_id 篩選"""
    try:
        results = await shared.run_in_qt_thread(shared.shioaji_client.list_positions)
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
        balance = await shared.run_in_qt_thread(shared.shioaji_client.get_account_balance)
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
            await shared.run_in_qt_thread(shared.shioaji_client.api.update_status)
        except Exception:
            pass

        trades = await shared.run_in_qt_thread(shared.shioaji_client.get_order_history)
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
        return await shared.run_in_qt_thread(shared.shioaji_client.get_all_accounts)
    except Exception as e:
        logger.error(f"獲取帳號列表失敗: {e}")
        return []


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
        await shared.run_in_qt_thread(client.api.update_status)
        # 2. list_trades → 活躍委託快照
        trades = await shared.run_in_qt_thread(client.get_order_history)
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
        positions = await shared.run_in_qt_thread(client.list_positions)
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
