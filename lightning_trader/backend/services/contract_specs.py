"""
contract_specs.py — 商品規格（合約乘數）唯一來源

之前 pnl_broadcaster / reports / equity_curve / position_tracker 各自複製了
一份乘數表且數值不一致，不同路徑會算出不同損益。統一收斂到這裡。
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
