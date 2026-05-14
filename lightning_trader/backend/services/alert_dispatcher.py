"""
alert_dispatcher.py — 把交易事件丟到使用者設定的 webhook URL

支援泛用 webhook（Discord / Slack incoming webhook、Telegram bot sendMessage、
任何接 application/json POST 的 endpoint）。

設計：
  - 從 ~/.lightrade/user_settings.json 讀 notifications.webhookUrl 與 notifications.events
  - dispatch_async(payload) 把 POST 派到 thread pool，**不**阻塞 caller
  - 失敗只 logger.warning，永不 raise — 通知失敗不該影響主交易流程
  - 用 urllib.request（stdlib）發送，避免新增 httpx / aiohttp deps

呼叫端：
  - bridge.on_shioaji_trade_update（Filled）
  - event_bus.on_risk_breach
"""
from __future__ import annotations
import json
import logging
import os
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# 用 1 worker 的 executor 序列化 webhook 呼叫，避免使用者 webhook 端被瞬間打爆
_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="alert-webhook")
_LOCK = threading.Lock()
_CACHED_CONFIG: Optional[dict] = None
_CACHE_MTIME: float = 0.0


def _settings_path() -> Path:
    raw = os.environ.get("LIGHTRADE_USER_SETTINGS")
    if raw:
        return Path(raw)
    return Path.home() / ".lightrade" / "user_settings.json"


def _load_notifications_config() -> dict:
    """從 user_settings.json 讀 notifications block。檔變更時 reload。"""
    global _CACHED_CONFIG, _CACHE_MTIME
    p = _settings_path()
    try:
        mtime = p.stat().st_mtime
    except FileNotFoundError:
        return {}
    with _LOCK:
        if _CACHED_CONFIG is not None and mtime == _CACHE_MTIME:
            return _CACHED_CONFIG
        try:
            full = json.loads(p.read_text(encoding="utf-8"))
            cfg = full.get("notifications") or {}
        except Exception as e:
            logger.warning(f"alert_dispatcher 讀 user_settings 失敗: {e}")
            cfg = {}
        _CACHED_CONFIG = cfg
        _CACHE_MTIME = mtime
        return cfg


def _is_event_enabled(cfg: dict, event: str) -> bool:
    """events 是 dict 形如 {fill: true, risk_breach: true}。預設都關，使用者要明確開。"""
    events = cfg.get("events") or {}
    return bool(events.get(event, False))


def _post_json(url: str, payload: dict) -> None:
    """同步 POST；只 5s timeout，跑在 worker thread 不會擋主流程。"""
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "LighTrade/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            if resp.status >= 400:
                logger.warning(f"alert_dispatcher POST {url} → {resp.status}")
    except urllib.error.URLError as e:
        logger.warning(f"alert_dispatcher POST {url} 失敗: {e}")
    except Exception as e:
        logger.warning(f"alert_dispatcher POST {url} 例外: {e}")


def _dispatch_now(event: str, message: str, extra: dict | None = None) -> None:
    """背景 worker 跑的；caller 不阻塞。"""
    cfg = _load_notifications_config()
    url = (cfg.get("webhookUrl") or "").strip()
    if not url:
        return
    if not _is_event_enabled(cfg, event):
        return
    payload: dict[str, Any] = {
        "event": event,
        "text": message,                        # Slack / Discord / 自架 webhook 都看 text
        "content": message,                     # Discord 用 content
        "source": "LighTrade",
    }
    if extra:
        payload["extra"] = extra
    _post_json(url, payload)


def dispatch_async(event: str, message: str, extra: dict | None = None) -> None:
    """從任意 thread / asyncio task 呼叫，立刻返回。"""
    try:
        _EXECUTOR.submit(_dispatch_now, event, message, extra)
    except Exception as e:
        logger.warning(f"alert_dispatcher submit 失敗: {e}")


# === 給 bridge / event_bus 直接呼叫的便利 wrapper ===

def on_fill(trade_data: dict) -> None:
    """從 bridge.on_shioaji_trade_update 觸發。"""
    if not isinstance(trade_data, dict):
        return
    state = str(trade_data.get("state", "") or "").lower()
    if "deal" not in state and "fill" not in state:
        return
    # 抽 message
    code = trade_data.get("code") or trade_data.get("symbol") or "?"
    action = trade_data.get("action") or "?"
    price = trade_data.get("price") or trade_data.get("deal_price") or "?"
    qty = trade_data.get("quantity") or trade_data.get("deal_quantity") or "?"
    side_zh = "買進" if str(action).lower() in ("b", "buy") else "賣出"
    msg = f"✅ 成交 {side_zh} {code} {qty}口 @ {price}"
    dispatch_async("fill", msg, extra={"symbol": str(code), "action": str(action),
                                         "price": price, "qty": qty})


def on_risk_breach(level: str, message: str) -> None:
    """從 event_bus.on_risk_breach 觸發。"""
    icon = "🚨" if level == "block" else "⚠️"
    dispatch_async("risk_breach", f"{icon} 風控警示 ({level}): {message}",
                   extra={"level": level})
