"""
position_sizer.py — 基於風險金額的倉位計算機

回答交易者最常問的問題：
  "我這次想冒險 NT$2,000，停損點 5 點，那該下幾口？"

公式：
    distance     = |entry_price - stop_price|
    risk_per_qty = distance * multiplier
    qty          = floor(risk_amount / risk_per_qty)

multiplier 來源：
  - 期貨 / 選擇權：contract.multiplier（從 Shioaji 取）
  - 股票：1（手續費忽略；零股 1 股 = 1 元）

回傳結構同時提供：
  - qty：建議口數
  - actual_risk：實際冒險金額（qty * risk_per_qty）
  - risk_per_qty：單口風險金額（方便使用者調整 stop 距離後預估）
  - warnings：當 risk_amount 不足以下 1 口、或 stop 與 entry 同價時的提示
"""
import logging
import math
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class SizingResult:
    qty: int
    risk_per_qty: float
    actual_risk: float
    distance: float
    multiplier: float
    warnings: list


def calc_qty(
    risk_amount: float,
    entry_price: float,
    stop_price: float,
    multiplier: float = 1.0,
    max_qty: int = 100,
) -> SizingResult:
    """
    給定風險金額與停損距離，計算建議下單口數。

    Args:
        risk_amount:  願意冒險的台幣金額（正數）
        entry_price:  預計進場價
        stop_price:   停損價（任一方向都可，函式取絕對距離）
        multiplier:   每點 / 每元價值；TXF=200、MXF=50、股票=1
        max_qty:      上限保護，防止輸入錯誤造成天量單

    Returns:
        SizingResult（qty=0 時 warnings 會說明原因）
    """
    warnings: list = []

    if risk_amount <= 0:
        return SizingResult(0, 0, 0, 0, multiplier, ["風險金額需 > 0"])
    if multiplier <= 0:
        return SizingResult(0, 0, 0, 0, multiplier, ["multiplier 無效"])

    distance = abs(entry_price - stop_price)
    if distance == 0:
        return SizingResult(0, 0, 0, 0, multiplier, ["進場價與停損價相同，無法計算"])

    risk_per_qty = distance * multiplier
    raw_qty = risk_amount / risk_per_qty
    qty = int(math.floor(raw_qty))

    if qty < 1:
        warnings.append(
            f"風險金額 {risk_amount:.0f} 不足以下 1 口（單口風險 {risk_per_qty:.0f}）"
        )
        qty = 0
    if qty > max_qty:
        warnings.append(f"計算口數 {qty} 超過上限 {max_qty}，已截斷")
        qty = max_qty

    actual_risk = qty * risk_per_qty
    return SizingResult(
        qty=qty,
        risk_per_qty=risk_per_qty,
        actual_risk=actual_risk,
        distance=distance,
        multiplier=multiplier,
        warnings=warnings,
    )
