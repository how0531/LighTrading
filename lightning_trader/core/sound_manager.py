"""
SoundManager — 音效事件路由器（後端不直接播音）

原版用 QSoundEffect 但 import 缺失、且 backend 在 docker headless 環境下
也播不出聲音。重新設計：

  - SoundManager 訂閱 event_bus 上的關鍵事件
  - 收到事件後呼叫 `emit_sound(event_name)` 把訊息送進 quote queue
  - 前端 SoundContext 訂閱 WS 的 `{"type": "Sound", "event": ...}` 並用 HTML5 Audio 播放
  - 後端保留 muted / volume 狀態給設定 UI 同步，但不阻擋訊息傳遞
    （前端自己決定要不要播）

事件對照：
  - on_fill                   → "fill"          訂單成交
  - on_order_placed           → "order_placed"  委託送出
  - on_order_cancelled        → "cancel"        刪單
  - on_risk_breach            → "alert"         風控警告（不可靜音）
  - on_connection_state(off)  → "disconnect"    連線中斷（不可靜音）
  - on_smart_order_triggered  → "smart_trigger" 智慧單觸發（停利/停損/OCO/Bracket）
"""
import logging
from typing import Callable, Optional

logger = logging.getLogger(__name__)


DEFAULT_SOUNDS = {
    "fill",
    "order_placed",
    "cancel",
    "alert",
    "disconnect",
    "smart_trigger",
}

UNMUTABLE_SOUNDS = {"alert", "disconnect"}


class SoundManager:
    """
    使用方式：
        sm = SoundManager(event_bus, emit_fn=push_to_ws_queue)
        # 自動接好；不需要其他事情
    """

    def __init__(self, event_bus, emit_fn: Optional[Callable[[dict], None]] = None):
        self.event_bus = event_bus
        self._emit = emit_fn      # (msg_dict) -> None；通常是「丟到 quotes_to_broadcast」
        self._muted: bool = False
        self._volume: float = 0.5    # 0.0 ~ 1.0

        # 訂閱事件
        self.event_bus.on_fill.connect(lambda _: self.emit_sound("fill"))
        self.event_bus.on_order_placed.connect(lambda _: self.emit_sound("order_placed"))
        self.event_bus.on_order_cancelled.connect(lambda _: self.emit_sound("cancel"))
        self.event_bus.on_risk_breach.connect(lambda level, _msg: self.emit_sound("alert"))
        self.event_bus.on_connection_state.connect(self._on_connection_state)
        self.event_bus.on_smart_order_triggered.connect(lambda _: self.emit_sound("smart_trigger"))

        logger.info("SoundManager 已初始化 (event router 模式)")

    def set_emit_fn(self, emit_fn: Callable[[dict], None]) -> None:
        """提供 emit 通道（main.py 啟動 lifespan 後注入）。"""
        self._emit = emit_fn

    def emit_sound(self, event_name: str) -> None:
        """送出一筆 Sound 事件到 WS（被靜音的事件不送，除非屬於 UNMUTABLE）。"""
        if event_name not in DEFAULT_SOUNDS:
            return
        if self._muted and event_name not in UNMUTABLE_SOUNDS:
            return
        if self._emit is None:
            return
        try:
            self._emit({
                "type": "Sound",
                "event": event_name,
                "volume": self._volume,
            })
        except Exception as e:
            logger.warning(f"emit sound 失敗: {e}")

    def _on_connection_state(self, state: str) -> None:
        if state == "disconnected":
            self.emit_sound("disconnect")

    # ──── 設定 ────

    def set_muted(self, muted: bool) -> None:
        self._muted = bool(muted)
        logger.info(f"[SoundManager] 靜音: {self._muted}")

    def set_volume(self, volume: float) -> None:
        self._volume = max(0.0, min(1.0, float(volume)))

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
            "available_sounds": sorted(DEFAULT_SOUNDS),
            "unmutable_sounds": sorted(UNMUTABLE_SOUNDS),
        }
