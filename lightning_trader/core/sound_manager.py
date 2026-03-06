"""
SoundManager — 音效管理器

在關鍵交易事件發生時播放音效提示。
支援音效開關、音量控制、自訂音效檔案。
"""
import logging
from typing import Dict, Optional
from pathlib import Path




logger = logging.getLogger(__name__)

# 預設音效事件映射
DEFAULT_SOUNDS = {
    "fill":         "fill.wav",         # 訂單成交
    "order_placed": "order.wav",        # 委託送出
    "cancel":       "cancel.wav",       # 刪單
    "alert":        "alert.wav",        # 風控警告
    "disconnect":   "disconnect.wav",   # 連線中斷
    "smart_trigger": "trigger.wav",     # 智慧單觸發
}

# 事件不可靜音 (安全相關)
UNMUTABLE_SOUNDS = {"alert", "disconnect"}


class SoundManager:
    """
    音效管理器

    使用方式:
        sm = SoundManager(event_bus, sound_dir="/path/to/sounds")
        sm.play("fill")  # 手動播放
        # 或自動播放 (已連接 EventBus 事件)
    """

    def __init__(self, event_bus, sound_dir: Optional[str] = None):
        self.event_bus = event_bus
        self.sound_dir = Path(sound_dir) if sound_dir else self._default_sound_dir()
        self._effects: Dict[str, QSoundEffect] = {}
        self._muted: bool = False
        self._volume: float = 0.5   # 0.0 ~ 1.0

        # 預載音效
        self._preload()

        # 連接事件
        self.event_bus.on_fill.connect(lambda _: self.play("fill"))
        self.event_bus.on_order_placed.connect(lambda _: self.play("order_placed"))
        self.event_bus.on_order_cancelled.connect(lambda _: self.play("cancel"))
        self.event_bus.on_risk_breach.connect(lambda level, _: self.play("alert"))
        self.event_bus.on_connection_state.connect(self._on_connection_state)
        self.event_bus.on_smart_order_triggered.connect(lambda _: self.play("smart_trigger"))

        logger.info(f"SoundManager 已初始化, 音效目錄: {self.sound_dir}")

    @staticmethod
    def _default_sound_dir() -> Path:
        return Path(__file__).parent.parent / "resources" / "sounds"

    def _preload(self):
        """預先載入所有音效檔案"""
        for event_name, filename in DEFAULT_SOUNDS.items():
            filepath = self.sound_dir / filename
            if filepath.exists():
                effect = QSoundEffect(self)
                effect.setSource(QUrl.fromLocalFile(str(filepath)))
                effect.setVolume(self._volume)
                self._effects[event_name] = effect
                logger.debug(f"已載入音效: {event_name} -> {filepath}")
            else:
                logger.debug(f"音效檔案不存在 (略過): {filepath}")

    # ──── 播放 ────

    def play(self, event_name: str):
        """播放指定事件的音效"""
        if self._muted and event_name not in UNMUTABLE_SOUNDS:
            return

        effect = self._effects.get(event_name)
        if effect:
            effect.play()

    def _on_connection_state(self, state: str):
        if state == "disconnected":
            self.play("disconnect")

    # ──── 設定 ────

    def set_muted(self, muted: bool):
        self._muted = muted
        logger.info(f"[SoundManager] 靜音: {muted}")

    def set_volume(self, volume: float):
        """設定音量 (0.0 ~ 1.0)"""
        self._volume = max(0.0, min(1.0, volume))
        for effect in self._effects.values():
            effect.setVolume(self._volume)

    @property
    def is_muted(self) -> bool:
        return self._muted

    @property
    def volume(self) -> float:
        return self._volume

    def get_status(self) -> dict:
        return {
            "muted": self._muted,
            "volume": self._volume,
            "loaded_sounds": list(self._effects.keys()),
            "available_sounds": list(DEFAULT_SOUNDS.keys()),
        }
