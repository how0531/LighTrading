"""
routers/user_settings.py — 使用者設定後端持久化

把 SettingsContext 的內容存成 JSON 檔，讓使用者跨裝置 / 重灌都能保留：
  - hotkeys
  - splitOrder
  - confirmations
  - visuals
  - theme / orderMode

存放路徑：`~/.lightrade/user_settings.json`。如果讀寫失敗就回 default。
"""
import json
import logging
from pathlib import Path
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["user_settings"])

_SETTINGS_DIR = Path.home() / ".lightrade"
_SETTINGS_PATH = _SETTINGS_DIR / "user_settings.json"


class UserSettingsPayload(BaseModel):
    # 任意鍵值：前端結構由 SettingsContext.tsx 定義，後端只負責 round-trip
    data: dict[str, Any]


def _ensure_dir() -> None:
    try:
        _SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        logger.warning(f"無法建立設定目錄 {_SETTINGS_DIR}: {e}")


@router.get("/user_settings")
async def get_user_settings():
    """讀取後端持久化的使用者設定。若無檔案回 {data: null}。"""
    try:
        if _SETTINGS_PATH.exists():
            return {"data": json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))}
    except Exception as e:
        logger.warning(f"讀取 user_settings 失敗: {e}")
    return {"data": None}


@router.put("/user_settings")
async def put_user_settings(payload: UserSettingsPayload):
    """覆寫整份 user_settings JSON。"""
    _ensure_dir()
    try:
        _SETTINGS_PATH.write_text(json.dumps(payload.data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"status": "success"}
    except Exception as e:
        logger.error(f"寫入 user_settings 失敗: {e}")
        return {"status": "error", "detail": {"code": "WRITE_FAILED", "user_msg": "設定無法寫入磁碟"}}
