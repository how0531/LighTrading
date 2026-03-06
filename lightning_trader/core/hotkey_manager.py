"""
HotkeyManager — 快捷鍵管理器

管理全域鍵盤快捷鍵的註冊、客製化與動態更新。
支援 PyQt5 QShortcut (桌面端) 和前端 KeyboardEvent 映射。
"""
import logging
from typing import Dict, Callable, Optional
from dataclasses import dataclass


logger = logging.getLogger(__name__)

# 預設快捷鍵映射
DEFAULT_HOTKEYS: Dict[str, str] = {
    # === 緊急操作 ===
    "Escape":       "cancel_all",           # 全刪（最高優先級）
    "Space":        "flatten_all",          # 全平（市價）

    # === 下單操作 ===
    "B":            "buy_at_bid",           # 內盤掛買
    "S":            "sell_at_ask",          # 外盤掛賣
    "Shift+B":      "buy_market",           # 市價買進
    "Shift+S":      "sell_market",          # 市價賣出

    # === 數量快速切換 ===
    "1":            "set_qty_1",
    "2":            "set_qty_2",
    "5":            "set_qty_5",
    "0":            "set_qty_10",

    # === 部位操作 ===
    "R":            "reverse_position",     # 反向
    "F":            "flatten_symbol",       # 平倉當前商品

    # === 檢視操作 ===
    "Tab":          "switch_symbol",        # 切換自選股
}

# 動作描述 (供設定 UI 顯示用)
ACTION_DESCRIPTIONS: Dict[str, str] = {
    "cancel_all":       "全部刪單",
    "flatten_all":      "全部平倉 (市價)",
    "buy_at_bid":       "內盤掛買 (最佳買價)",
    "sell_at_ask":      "外盤掛賣 (最佳賣價)",
    "buy_market":       "市價買進",
    "sell_market":      "市價賣出",
    "set_qty_1":        "設定口數 = 1",
    "set_qty_2":        "設定口數 = 2",
    "set_qty_5":        "設定口數 = 5",
    "set_qty_10":       "設定口數 = 10",
    "reverse_position": "反向 (翻倉)",
    "flatten_symbol":   "平倉當前商品",
    "switch_symbol":    "切換自選股",
}


@dataclass
class HotkeyBinding:
    """快捷鍵綁定"""
    key: str           # 按鍵組合 (如 "Shift+B")
    action: str        # 動作 ID (如 "buy_market")
    description: str   # 描述 (如 "市價買進")
    enabled: bool = True


class HotkeyManager:
    """
    快捷鍵管理器

    使用方式:
        hm = HotkeyManager(event_bus)
        hm.register_handler("cancel_all", my_cancel_fn)
        hm.trigger("cancel_all")  # 手動觸發
        # 或由 QShortcut / 前端 keydown 事件觸發
    """

    def __init__(self, event_bus):
        self.event_bus = event_bus
        self._bindings: Dict[str, HotkeyBinding] = {}
        self._handlers: Dict[str, Callable] = {}

        # 載入設定或使用預設值
        self._load_bindings()
        logger.info(f"HotkeyManager 已初始化, {len(self._bindings)} 組快捷鍵")

    def _load_bindings(self):
        """從記憶體或預設值載入自訂快捷鍵"""
        for key, action in DEFAULT_HOTKEYS.items():
            self._bindings[action] = HotkeyBinding(
                key=key,
                action=action,
                description=ACTION_DESCRIPTIONS.get(action, action),
            )

    def save_bindings(self):
        """目前為無頭後端，儲存邏輯由前端 LocalStorage 處理"""
        pass

    # ──── 註冊處理函數 ────

    def register_handler(self, action: str, handler: Callable):
        """註冊動作處理函數"""
        self._handlers[action] = handler
        logger.debug(f"已註冊快捷鍵處理: {action}")

    def register_handlers(self, handlers: Dict[str, Callable]):
        """批次註冊"""
        for action, handler in handlers.items():
            self._handlers[action] = handler

    # ──── 觸發 ────

    def trigger(self, action: str) -> bool:
        """觸發指定動作"""
        binding = self._bindings.get(action)
        if binding and not binding.enabled:
            logger.debug(f"快捷鍵已停用: {action}")
            return False

        handler = self._handlers.get(action)
        if handler:
            try:
                handler()
                logger.info(f"[Hotkey] 觸發: {action} ({binding.description if binding else ''})")
                return True
            except Exception as e:
                logger.error(f"[Hotkey] 執行失敗: {action} - {e}")
                self.event_bus.on_error.emit("warning", f"快捷鍵執行失敗: {e}")
                return False
        else:
            logger.warning(f"[Hotkey] 未找到處理函數: {action}")
            return False

    def trigger_by_key(self, key_combo: str) -> bool:
        """根據按鍵組合觸發對應動作"""
        for action, binding in self._bindings.items():
            if binding.key == key_combo and binding.enabled:
                return self.trigger(action)
        return False

    # ──── 設定 ────

    def update_binding(self, action: str, new_key: str):
        """更新快捷鍵綁定"""
        if action in self._bindings:
            old_key = self._bindings[action].key
            self._bindings[action].key = new_key
            logger.info(f"[Hotkey] 更新: {action} {old_key} -> {new_key}")

    def set_enabled(self, action: str, enabled: bool):
        """啟用/停用特定快捷鍵"""
        if action in self._bindings:
            self._bindings[action].enabled = enabled

    def reset_to_defaults(self):
        """重設為預設快捷鍵"""
        self._bindings.clear()
        for key, action in DEFAULT_HOTKEYS.items():
            self._bindings[action] = HotkeyBinding(
                key=key,
                action=action,
                description=ACTION_DESCRIPTIONS.get(action, action),
            )
        logger.info("快捷鍵已重設為預設值")

    # ──── 查詢 ────

    def get_all_bindings(self) -> list:
        """取得所有快捷鍵綁定 (供設定 UI 使用)"""
        return [
            {
                "key": b.key,
                "action": b.action,
                "description": b.description,
                "enabled": b.enabled,
            }
            for b in self._bindings.values()
        ]

    def get_key_for_action(self, action: str) -> Optional[str]:
        """取得動作對應的按鍵"""
        binding = self._bindings.get(action)
        return binding.key if binding else None

    def get_frontend_keymap(self) -> Dict[str, str]:
        """
        取得前端用的鍵盤映射 (key_combo → action)
        供前端 useEffect keydown 事件使用
        """
        return {
            b.key: b.action
            for b in self._bindings.values()
            if b.enabled
        }
