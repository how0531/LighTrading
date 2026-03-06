"""
RiskManager — 統一的風控與防呆引擎

合併了原本分離的 OrderValidator 和 RiskManager 職責：
 - 下單前防呆檢查 (block / warning 兩級別)
 - 即時風控監控 (日虧損、頻率)
 - 定期巡檢 (自動停止交易)

設計原則: Single source of truth — 所有下單前的驗證都通過這一個入口。
"""
import logging
import time
from enum import Enum
from typing import Tuple, Optional, Dict
from dataclasses import dataclass



logger = logging.getLogger(__name__)


class CheckLevel(Enum):
    """檢查結果等級"""
    OK = "ok"             # 通過
    BLOCK = "block"       # 直接攔截
    WARNING = "warning"   # 警告，使用者可選擇繼續


@dataclass
class CheckResult:
    """檢查結果"""
    level: CheckLevel
    reason: str = ""

    @property
    def passed(self) -> bool:
        return self.level == CheckLevel.OK

    @staticmethod
    def ok():
        return CheckResult(CheckLevel.OK)

    @staticmethod
    def block(reason: str):
        return CheckResult(CheckLevel.BLOCK, reason)

    @staticmethod
    def warn(reason: str):
        return CheckResult(CheckLevel.WARNING, reason)


@dataclass
class RiskConfig:
    """統一風控設定（可由 SettingsContext 同步更新）"""
    # ── 部位上限 ──
    max_position_per_symbol: int = 10
    max_position_enabled: bool = True

    # ── 每日最大虧損 ──
    max_daily_loss: float = -50000.0
    max_daily_loss_enabled: bool = True

    # ── 價格偏離警告 ──
    price_deviation_pct: float = 2.0
    price_deviation_enabled: bool = True

    # ── 下單頻率上限 (N 筆/秒) ──
    max_order_rate: int = 5
    max_order_rate_enabled: bool = True

    # ── 重複下單檢查 ──
    duplicate_window_ms: int = 500
    duplicate_check_enabled: bool = True

    # ── 市價單確認 ──
    market_order_confirm: bool = True

    # ── 反向加碼確認 ──
    reverse_confirm: bool = True

    # ── 全域交易開關 ──
    trading_enabled: bool = True


class RiskManager:
    """
    統一風控引擎

    使用流程:
        result = risk_manager.pre_order_check(symbol, action, qty, price, ...)
        if result.level == CheckLevel.BLOCK:
            reject_order(result.reason)
        elif result.level == CheckLevel.WARNING:
            if user_confirms(result.reason):
                proceed_order()
        else:
            proceed_order()
    """

    def __init__(self, event_bus, config: Optional[RiskConfig] = None):
        self.event_bus = event_bus
        self.config = config or RiskConfig()

        # 即時狀態
        self._daily_realized_pnl: float = 0.0
        self._daily_unrealized_pnl: float = 0.0
        self._order_timestamps: list = []
        self._recent_orders: list = []       # (ts_ms, symbol, action, price, qty)
        self._current_positions: Dict[str, int] = {}  # symbol -> net_qty
        self._current_prices: Dict[str, float] = {}

        # 監聽 EventBus
        self.event_bus.on_tick.connect(self._on_tick)
        self.event_bus.on_fill.connect(self._on_fill)
        self.event_bus.on_position_update.connect(self._on_position_update)

        # 移除 QTimer，改為由外部 (如事件迴圈) 或被動觸發
        self._last_check_time = time.time()

        logger.info("RiskManager 已初始化")

    # ──── 事件處理 ────

    def _on_tick(self, symbol: str, tick_data: dict):
        price = tick_data.get("Price", 0)
        if price > 0:
            self._current_prices[symbol] = price

    def _on_fill(self, fill_data: dict):
        self._order_timestamps.append(time.time())

    def _on_position_update(self, pos_data: dict):
        self._daily_unrealized_pnl = pos_data.get("total_unrealized_pnl", 0)
        for p in pos_data.get("positions", []):
            self._current_positions[p["symbol"]] = p["net_qty"]
            
        # 順便觸發日虧損檢查
        self._periodic_check()

    def _periodic_check(self):
        """定期風控巡檢 — 日虧損觸發時自動停止交易"""
        if not self.config.max_daily_loss_enabled:
            return
        total = self._daily_realized_pnl + self._daily_unrealized_pnl
        if total <= self.config.max_daily_loss and self.config.trading_enabled:
            self.config.trading_enabled = False
            msg = (f"日虧損 {total:,.0f} 已觸及上限 "
                   f"{self.config.max_daily_loss:,.0f}，交易已自動停止")
            self.event_bus.on_risk_breach.emit("block", msg)
            logger.warning(f"[RiskManager] {msg}")

    # ──── 下單前統一檢查入口 ────

    def pre_order_check(
        self,
        symbol: str,
        action: str,
        qty: int,
        price: float,
        is_market_order: bool = False,
        position_qty: int = 0,
        position_direction: str = "Flat",
    ) -> CheckResult:
        """
        下單前完整檢查（唯一入口）

        Args:
            symbol: 商品代碼
            action: "Buy" | "Sell"
            qty: 委託口數
            price: 委託價格 (0 = 市價)
            is_market_order: 是否為市價單
            position_qty: 目前該商品持倉數量
            position_direction: 目前持倉方向 "Buy"|"Sell"|"Flat"

        Returns:
            CheckResult (level, reason)
        """
        symbol = symbol.strip().upper()

        # === 0. 基本參數驗證 ===
        if qty <= 0:
            return CheckResult.block("委託口數必須大於 0")
        if price < 0:
            return CheckResult.block("委託價格不可為負數")

        # === 1. 全域交易開關 ===
        if not self.config.trading_enabled:
            return CheckResult.block("交易已被風控停止，請確認日虧損狀況")

        # === 2. 日虧損上限 ===
        r = self._check_daily_loss()
        if not r.passed:
            return r

        # === 3. 部位上限 ===
        r = self._check_max_position(symbol, action, qty, position_qty)
        if not r.passed:
            return r

        # === 4. 下單頻率 ===
        r = self._check_order_rate()
        if not r.passed:
            return r

        # === 5. 重複下單 ===
        r = self._check_duplicate(symbol, action, price, qty)
        if not r.passed:
            return r

        # === 6. 價格偏離 (warning) ===
        current_price = self._current_prices.get(symbol, 0)
        r = self._check_price_deviation(price, current_price, is_market_order)
        if not r.passed:
            return r

        # === 7. 市價單確認 (warning) ===
        if self.config.market_order_confirm and (is_market_order or price == 0):
            return CheckResult.warn(
                f"確認送出市價{'買進' if action == 'Buy' else '賣出'} "
                f"{symbol} {qty}口？"
            )

        # === 8. 反向加碼確認 (warning) ===
        r = self._check_reverse(action, position_direction)
        if not r.passed:
            return r

        # 全通過 → 記錄委託供重複偵測
        self._record_order(symbol, action, price, qty)
        return CheckResult.ok()

    # ──── 各項檢查實作 ────

    def _check_daily_loss(self) -> CheckResult:
        if not self.config.max_daily_loss_enabled:
            return CheckResult.ok()
        total = self._daily_realized_pnl + self._daily_unrealized_pnl
        if total <= self.config.max_daily_loss:
            return CheckResult.block(
                f"日虧損 {total:,.0f} 已達上限 {self.config.max_daily_loss:,.0f}"
            )
        return CheckResult.ok()

    def _check_max_position(self, symbol: str, action: str,
                            qty: int, current_qty: int) -> CheckResult:
        if not self.config.max_position_enabled:
            return CheckResult.ok()
        # 優先使用傳入的 current_qty，fallback 到內部追蹤
        if current_qty == 0:
            current_qty = self._current_positions.get(symbol, 0)
        projected = current_qty + qty if action == "Buy" else current_qty - qty
        if abs(projected) > self.config.max_position_per_symbol:
            reason = (f"超過部位上限: 目前 {current_qty} 口，下單後 {projected} 口 "
                      f"(上限 {self.config.max_position_per_symbol})")
            self.event_bus.on_risk_breach.emit("warning", reason)
            return CheckResult.block(reason)
        return CheckResult.ok()

    def _check_order_rate(self) -> CheckResult:
        if not self.config.max_order_rate_enabled:
            return CheckResult.ok()
        now = time.time()
        self._order_timestamps = [t for t in self._order_timestamps if now - t < 1.0]
        if len(self._order_timestamps) >= self.config.max_order_rate:
            return CheckResult.block(
                f"下單頻率超限: {len(self._order_timestamps)}/{self.config.max_order_rate} 筆/秒"
            )
        return CheckResult.ok()

    def _check_duplicate(self, symbol: str, action: str,
                         price: float, qty: int) -> CheckResult:
        if not self.config.duplicate_check_enabled:
            return CheckResult.ok()
        now_ms = time.time() * 1000
        window = self.config.duplicate_window_ms
        # 清理過期
        self._recent_orders = [r for r in self._recent_orders if now_ms - r[0] < window * 3]
        for ts, s, a, p, q in self._recent_orders:
            if (now_ms - ts < window and s == symbol
                    and a == action and p == price and q == qty):
                return CheckResult.block(
                    f"偵測到重複委託: {action} {symbol} {qty}口 @ {price} "
                    f"({int(now_ms - ts)}ms 內重複)")
        return CheckResult.ok()

    def _check_price_deviation(self, price: float, current_price: float,
                                is_market: bool) -> CheckResult:
        if not self.config.price_deviation_enabled:
            return CheckResult.ok()
        if is_market or price == 0 or current_price == 0:
            return CheckResult.ok()
        dev = abs(price - current_price) / current_price * 100
        if dev > self.config.price_deviation_pct:
            return CheckResult.warn(
                f"委託價 {price} 偏離現價 {current_price} 達 {dev:.1f}%"
            )
        return CheckResult.ok()

    def _check_reverse(self, action: str, direction: str) -> CheckResult:
        if not self.config.reverse_confirm or direction == "Flat":
            return CheckResult.ok()
        is_reverse = (
            (direction == "Buy" and action == "Sell") or
            (direction == "Sell" and action == "Buy")
        )
        if is_reverse:
            return CheckResult.warn(
                f"目前持有{'多' if direction == 'Buy' else '空'}單，"
                f"確認要{'賣出' if action == 'Sell' else '買進'}（反向）？"
            )
        return CheckResult.ok()

    def _record_order(self, symbol: str, action: str, price: float, qty: int):
        self._recent_orders.append(
            (time.time() * 1000, symbol, action, price, qty)
        )

    # ──── 管理 ────

    def update_config(self, **kwargs):
        for key, value in kwargs.items():
            if hasattr(self.config, key):
                setattr(self.config, key, value)
                logger.info(f"[RiskManager] 設定更新: {key} = {value}")

    def reset_daily(self):
        self._daily_realized_pnl = 0.0
        self._daily_unrealized_pnl = 0.0
        self._order_timestamps.clear()
        self._recent_orders.clear()
        self.config.trading_enabled = True
        logger.info("[RiskManager] 日內狀態已重設")

    def get_status(self) -> dict:
        total = self._daily_realized_pnl + self._daily_unrealized_pnl
        return {
            "trading_enabled": self.config.trading_enabled,
            "daily_realized_pnl": self._daily_realized_pnl,
            "daily_unrealized_pnl": self._daily_unrealized_pnl,
            "daily_total_pnl": total,
            "max_daily_loss": self.config.max_daily_loss,
            "pnl_ratio": (total / abs(self.config.max_daily_loss) * 100)
                         if self.config.max_daily_loss != 0 else 0,
            "max_position": self.config.max_position_per_symbol,
        }
