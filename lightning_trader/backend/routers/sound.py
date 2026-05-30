"""
routers/sound.py — 音效設定（後端只管狀態，實際播音在前端）

  GET /api/sound/status        當前狀態（muted / volume / 可用事件）
  PUT /api/sound/config        更新 muted / volume
  POST /api/sound/test          手動觸發一筆指定事件（給設定頁試聽）
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from backend import shared

router = APIRouter(prefix="/api/sound", tags=["sound"])


def _sm():
    sm = getattr(shared.engine, "sound_manager", None)
    if sm is None:
        raise HTTPException(status_code=503, detail={
            "code": "SOUND_UNAVAILABLE", "user_msg": "SoundManager 尚未初始化"
        })
    return sm


class SoundConfig(BaseModel):
    muted: Optional[bool] = None
    volume: Optional[float] = Field(default=None, ge=0, le=1)


class TestSoundReq(BaseModel):
    event: str  # 例如 "fill", "alert"


@router.get("/status")
async def status():
    return _sm().get_status()


@router.put("/config")
async def config(payload: SoundConfig):
    sm = _sm()
    if payload.muted is not None:
        sm.set_muted(payload.muted)
    if payload.volume is not None:
        sm.set_volume(payload.volume)
    return {"status": "success", **sm.get_status()}


@router.post("/test")
async def test(req: TestSoundReq):
    _sm().emit_sound(req.event)
    return {"status": "success", "event": req.event}
