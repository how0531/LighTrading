"""
contract_specs.py — 商品規格（合約乘數 / tick 級距）唯一來源

之前 pnl_broadcaster / reports / equity_curve / position_tracker 各自複製了
一份乘數表且數值不一致，不同路徑會算出不同損益。統一收斂到這裡。

注意：本模組必須保持「模組層零依賴」（reports.py 依賴此不變量避免循環引用；
離線測試也直接 import）。tick 級距的實作放在 core.smart_order_engine
（CHASE 追價的保底 fallback，core 不得反向依賴 backend），這裡用
函數內 lazy import 委派，避免模組層拉進 core（→ shioaji）依賴鏈。
"""

# 期貨合約乘數（symbol 前綴 → 每點價值）；股票以「張」計 → 1000 股
FUTURES_MULTIPLIERS: dict[str, int] = {
    "TXF": 200,   # 大台
    "MXF": 50,    # 小台
    "EXF": 4000,  # 電子期
    "GTF": 200,
}

STOCK_MULTIPLIER = 1000


def get_multiplier(symbol: str) -> int:
    sym = (symbol or "").upper()
    for prefix, mult in FUTURES_MULTIPLIERS.items():
        if sym.startswith(prefix):
            return mult
    return STOCK_MULTIPLIER


def get_tick_size(price: float, symbol: str) -> float:
    """取得指定價格 / 商品的 tick 級距（與前端 utils/instrument.ts 一致）。

    lazy import：唯一實作在 core.smart_order_engine.default_tick_size。
    """
    from core.smart_order_engine import default_tick_size
    return default_tick_size(price, symbol)
