"""
RiskManager — 統一的風控與防呆引擎

職責：
 - 下單前防呆檢查 (block / warning 兩級別)
 - 即時風控監控 (日虧損、頻率)
 - 日虧損觸發時自動停止交易

資料餵入（由 backend 主動呼叫，不再依賴死掉的 OrderManager 事件鏈）：
 - update_daily_pnl(realized=…, unrealized=…)：pnl_broadcaster / 成交回報路徑餵入
 - update_positions([...])：pnl_broadcaster 的持倉快照餵入
 - on_tick（EventBus）：更新現價供價格偏離檢查

設計原則: Single source of truth — 所有下單前的驗證都通過 pre_order_check。
"""
import logging
import os
import time
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional, Dict, List
from dataclasses import dataclass, field



logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    """讀環境變數為 int；未設 / 空 / 不合法 → default。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        v = int(float(raw))
        return v if v >= 0 else default
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
        return v if v >= 0 else default
    except (TypeError, ValueError):
        return default


def risk_day_start_ms(now: Optional[datetime] = None) -> int:
    """
    風控日邊界：每日 04:00（與 order_guard._risk_day_start_ms /
    main.py _daily_risk_reset 對齊）。每日硬上限計數以此邊界歸零。
    """
    now = now or datetime.now()
    start = now.replace(hour=4, minute=0, second=0, microsecond=0)
    if now < start:
        start -= timedelta(days=1)
    return int(start.timestamp() * 1000)


def signed_position_qty(direction, qty) -> int:
    """
    部位方向 → 有號口數的唯一定義：Buy 為正、Sell 為負。

    ★ 未知 / 缺漏的 direction 一律回 0（不猜方向）——
    之前三處各自複製這段邏輯且預設相反（risk_manager 視非 Sell 為 +、
    order_guard/orders.py 視非 Buy 為 −），同一筆部位在兩道防線會算出
    正負相反的淨額。
    """
    try:
        q = int(qty or 0)
    except (TypeError, ValueError):
        return 0
    d = str(direction or "")
    if d == "Buy":
        return q
    if d == "Sell":
        return -q
    return 0


def net_position_of(positions, symbol: str) -> int:
    """把持倉列表聚合成指定商品的有號淨部位（多帳號/多列相加）。"""
    sym = (symbol or "").strip().upper()
    net = 0
    for p in positions or []:
        if (p.get("symbol") or "").upper() != sym:
            continue
        net += signed_position_qty(p.get("direction"), p.get("qty", 0))
    return net


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
    warnings: List[str] = field(default_factory=list)
    # 暫態 BLOCK（如頻率限制）：呼叫端（智慧單觸發 / CHASE 改價）應「本次放棄、
    # 下輪重試」，而非把整張單終結。與真正的風控封鎖（部位/日虧損/交易停止）區分。
    transient: bool = False

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
    def block_transient(reason: str):
        """暫態封鎖（頻率限制）：可重試，不應終結整張智慧單。"""
        return CheckResult(CheckLevel.BLOCK, reason, transient=True)

    @staticmethod
    def warn(reason: str, warnings: Optional[List[str]] = None):
        return CheckResult(CheckLevel.WARNING, reason, warnings or [reason])


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
            前端確認後帶 confirm=true 重送 → pre_order_check(..., skip_warnings=True)
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
        self._current_positions: Dict[str, int] = {}  # symbol -> net_qty（有號）
        self._current_prices: Dict[str, float] = {}
        # 最近一次 reset_daily 的時間（ms）— 已實現損益重算以此為基線，
        # 避免手動 reset 後下一筆成交的全日重算又把舊虧損加回來
        self.last_reset_ms: float = 0.0

        # ──── 每日硬上限（獨立於「日虧損熔斷」的獨立防線）────
        # ★ 預設安全：未設環境變數或 0 = 無限（不改變現有交易行為）。
        #   達上限回 BLOCK（fail-closed）。以風控日邊界（04:00）計數/歸零。
        self.max_orders_per_day: int = _env_int("LIGHTRADE_MAX_ORDERS_PER_DAY", 0)
        self.max_notional_per_day: float = _env_float("LIGHTRADE_MAX_NOTIONAL_PER_DAY", 0.0)
        self._daily_order_count: int = 0
        self._daily_notional: float = 0.0
        self._count_boundary_ms: int = risk_day_start_ms()

        # ──── 異常速率凍結（panic rate）────
        # ★ 預設關閉：LIGHTRADE_PANIC_RATE=0 = 不檢查。設 N>0 時，短時間窗
        #   （LIGHTRADE_PANIC_RATE_WINDOW_S，預設 10s）內下單數 > N 即自動
        #   trading_enabled=False + critical 告警。
        self.panic_rate: int = _env_int("LIGHTRADE_PANIC_RATE", 0)
        self.panic_rate_window_s: float = _env_float("LIGHTRADE_PANIC_RATE_WINDOW_S", 10.0)
        self._panic_timestamps: list = []

        # 監聽 EventBus（現價供價格偏離檢查）
        self.event_bus.on_tick.connect(self._on_tick)

        logger.info(
            "RiskManager 已初始化 (max_orders/day=%s, max_notional/day=%s, panic_rate=%s)",
            self.max_orders_per_day or "∞",
            self.max_notional_per_day or "∞",
            self.panic_rate or "off")

    # ──── 事件 / 資料餵入 ────

    def _on_tick(self, symbol: str, tick_data: dict):
        price = tick_data.get("Price", 0)
        if price > 0:
            self._current_prices[symbol] = price

    def update_daily_pnl(self, realized: Optional[float] = None,
                         unrealized: Optional[float] = None):
        """由 backend 餵入日損益（realized 來自 journal FIFO、unrealized 來自 pnl_broadcaster）。"""
        if realized is not None:
            self._daily_realized_pnl = float(realized)
        if unrealized is not None:
            self._daily_unrealized_pnl = float(unrealized)
        self._periodic_check()

    def update_positions(self, positions: List[dict]):
        """由 pnl_broadcaster 餵入持倉快照。positions: [{symbol, qty, direction}, ...]"""
        net: Dict[str, int] = {}
        for p in positions or []:
            sym = (p.get("symbol") or "").upper()
            if not sym:
                continue
            net[sym] = net.get(sym, 0) + signed_position_qty(p.get("direction"), p.get("qty", 0))
        self._current_positions = net

    def _periodic_check(self):
        """風控巡檢 — 日虧損觸發時自動停止交易"""
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
        skip_warnings: bool = False,
        skip_duplicate: bool = False,
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
            skip_warnings: True = WARNING 級別視為已確認（confirm 重送 / 智慧單觸發）
            skip_duplicate: True = 跳過重複委託檢查（智慧單觸發 — 兩張同參數的
                智慧單在同一 tick 觸發是合法情境，不是手震連點）

        Returns:
            CheckResult (level, reason, warnings)
        """
        symbol = symbol.strip().upper()
        warnings: List[str] = []

        # 跨風控日（04:00）→ 每日硬上限計數歸零
        self._roll_daily_counters_if_needed()

        # === 0. 基本參數驗證 ===
        if qty <= 0:
            return CheckResult.block("委託口數必須大於 0")
        if price < 0:
            return CheckResult.block("委託價格不可為負數")

        # ★ reduce-only 判定（唯一定義點）：方向與現有淨部位相反、
        #   且口數不超過淨部位 → 純平倉/減倉。
        #   熔斷（步驟 1/2）不得封鎖出場 —— 之前這個例外只做在智慧單
        #   觸發路徑與 flatten 按鈕，「手動下單面板」在熔斷後連平倉單
        #   都送不出去，使用者被鎖在虧損部位裡。
        if position_qty != 0:
            net_current = signed_position_qty(position_direction, position_qty)
        else:
            net_current = self._current_positions.get(symbol, 0)
        delta = qty if action == "Buy" else -qty
        is_reduce_only = (net_current != 0 and net_current * delta < 0
                          and abs(delta) <= abs(net_current))

        # === 1. 全域交易開關（reduce-only 豁免） ===
        if not self.config.trading_enabled and not is_reduce_only:
            return CheckResult.block("交易已被風控停止，請確認日虧損狀況（平倉單不受此限）")

        # === 2. 日虧損上限（reduce-only 豁免） ===
        if not is_reduce_only:
            r = self._check_daily_loss()
            if not r.passed:
                return r

        # === 2.5 每日硬上限（下單筆數 / 名目金額；reduce-only 豁免） ===
        # 硬上限是「總量斷路器」，與日虧損熔斷各自獨立。豁免 reduce-only ——
        # 與熔斷/日虧損一致，永不擋出場，避免把使用者鎖在部位裡。
        if not is_reduce_only:
            r = self._check_daily_hard_caps(symbol, qty, price, is_market_order)
            if not r.passed:
                return r

        # === 3. 部位上限 ===
        r = self._check_max_position(symbol, action, qty, position_qty, position_direction)
        if not r.passed:
            return r

        # === 4. 下單頻率 ===
        r = self._check_order_rate()
        if not r.passed:
            return r

        # === 5. 重複下單 ===
        if not skip_duplicate:
            r = self._check_duplicate(symbol, action, price, qty)
            if not r.passed:
                return r

        # === 6. 價格偏離 (warning) ===
        current_price = self._current_prices.get(symbol, 0)
        r = self._check_price_deviation(price, current_price, is_market_order)
        if r.level == CheckLevel.WARNING:
            warnings.append(r.reason)

        # === 7. 市價單確認 (warning) ===
        if self.config.market_order_confirm and (is_market_order or price == 0):
            warnings.append(
                f"確認送出市價{'買進' if action == 'Buy' else '賣出'} "
                f"{symbol} {qty}口？"
            )

        # === 8. 反向加碼確認 (warning) ===
        r = self._check_reverse(action, position_direction)
        if r.level == CheckLevel.WARNING:
            warnings.append(r.reason)

        if warnings and not skip_warnings:
            return CheckResult(CheckLevel.WARNING, "; ".join(warnings), warnings)

        # 通過（或警告已確認）→ 記錄委託供重複偵測 + 頻率統計
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
                            qty: int, current_qty: int,
                            current_direction: str = "Flat") -> CheckResult:
        """
        反向加碼（持有空單時下買單）算「平倉」而非「加碼」：
        把 (current_qty, current_direction) 轉成有號淨部位，再加上有號委託量。
        """
        if not self.config.max_position_enabled:
            return CheckResult.ok()
        # 把現有部位轉成有號值
        if current_qty == 0:
            # fallback：內部追蹤已是有號 net
            net_current = self._current_positions.get(symbol, 0)
        elif current_direction == "Sell":
            net_current = -current_qty
        else:
            net_current = current_qty
        # 委託 → 有號增減
        delta = qty if action == "Buy" else -qty
        projected = net_current + delta
        if abs(projected) > self.config.max_position_per_symbol:
            reason = (f"超過部位上限: 目前淨 {net_current} 口，下單後淨 {projected} 口 "
                      f"(上限 ±{self.config.max_position_per_symbol})")
            self.event_bus.on_risk_breach.emit("warning", reason)
            return CheckResult.block(reason)
        return CheckResult.ok()

    def _notional_of(self, symbol: str, qty: int, price: float,
                     is_market: bool) -> float:
        """
        單筆名目金額（best-effort）：qty × 價格。市價 / price=0 時退回現價。
        取不到價格 → 0（不灌水；名目上限只在有價時才實質生效）。
        注意：此處未乘合約乘數（core 不依賴 backend 的 contract_specs），
        屬保守低估；期貨可依乘數把 LIGHTRADE_MAX_NOTIONAL_PER_DAY 折算後設定。
        """
        px = price if price and price > 0 else self._current_prices.get(symbol, 0)
        try:
            return abs(int(qty)) * float(px or 0)
        except (TypeError, ValueError):
            return 0.0

    def _roll_daily_counters_if_needed(self) -> None:
        """跨過風控日邊界（04:00）→ 每日硬上限計數歸零。"""
        boundary = risk_day_start_ms()
        if boundary > self._count_boundary_ms:
            self._daily_order_count = 0
            self._daily_notional = 0.0
            self._count_boundary_ms = boundary

    def _check_daily_hard_caps(self, symbol: str, qty: int, price: float,
                               is_market: bool) -> CheckResult:
        """
        每日硬上限（下單筆數 / 名目金額）。未設（0）= 無限 → 直接放行。
        達上限回 BLOCK（fail-closed）。計數在通過檢查、實際送單時
        （_record_order）才累加，故此處以「若再送這一筆是否超限」判定。
        """
        if self.max_orders_per_day and self._daily_order_count >= self.max_orders_per_day:
            reason = (f"已達每日下單筆數上限 "
                      f"{self._daily_order_count}/{self.max_orders_per_day}")
            self.event_bus.on_risk_breach.emit("block", reason)
            return CheckResult.block(reason)
        if self.max_notional_per_day:
            projected = self._daily_notional + self._notional_of(
                symbol, qty, price, is_market)
            if projected > self.max_notional_per_day:
                reason = (f"已達每日名目金額上限 "
                          f"{projected:,.0f}/{self.max_notional_per_day:,.0f}")
                self.event_bus.on_risk_breach.emit("block", reason)
                return CheckResult.block(reason)
        return CheckResult.ok()

    def _check_panic_rate(self) -> None:
        """
        異常速率凍結：短時間窗內下單數超過硬閾值 panic_rate → 自動熔斷 +
        critical 告警。預設 panic_rate=0 → 關閉。於每次實際送單後呼叫。
        """
        if not self.panic_rate:
            return
        now = time.time()
        window = self.panic_rate_window_s
        self._panic_timestamps = [t for t in self._panic_timestamps if now - t < window]
        if len(self._panic_timestamps) > self.panic_rate and self.config.trading_enabled:
            self.config.trading_enabled = False
            msg = (f"異常下單速率：{len(self._panic_timestamps)} 筆 / {window:.0f}s "
                   f"超過硬閾值 {self.panic_rate}，已自動停止交易 (trading_enabled=False)")
            logger.critical(f"[RiskManager] {msg}")
            self.event_bus.on_risk_breach.emit("critical", msg)

    def _check_order_rate(self) -> CheckResult:
        if not self.config.max_order_rate_enabled:
            return CheckResult.ok()
        now = time.time()
        self._order_timestamps = [t for t in self._order_timestamps if now - t < 1.0]
        if len(self._order_timestamps) >= self.config.max_order_rate:
            # 頻率超限是「暫態」封鎖：智慧單/CHASE 應本輪放棄、下輪重試（#8）
            return CheckResult.block_transient(
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
        now = time.time()
        self._order_timestamps.append(now)
        self._recent_orders.append(
            (now * 1000, symbol, action, price, qty)
        )
        # 每日硬上限計數（實際送出才累加）
        self._roll_daily_counters_if_needed()
        self._daily_order_count += 1
        self._daily_notional += self._notional_of(symbol, qty, price, price == 0)
        # 異常速率凍結鉤子
        self._panic_timestamps.append(now)
        self._check_panic_rate()

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
        # 每日硬上限 / 速率凍結計數一併歸零
        self._daily_order_count = 0
        self._daily_notional = 0.0
        self._panic_timestamps.clear()
        self._count_boundary_ms = risk_day_start_ms()
        self.config.trading_enabled = True
        self.last_reset_ms = time.time() * 1000
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
            # 每日硬上限（0 = 無限）與當日計數
            "daily_order_count": self._daily_order_count,
            "max_orders_per_day": self.max_orders_per_day,
            "daily_notional": self._daily_notional,
            "max_notional_per_day": self.max_notional_per_day,
            "panic_rate": self.panic_rate,
        }
