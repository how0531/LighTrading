"""
contract_specs.py — 後端合約乘數單一真相源

集中原本分別寫在 pnl_broadcaster / reports / equity_curve 三處、值完全相同的
乘數表（TXF 大台 200 / MXF 小台 50 / EXF 電子 4000 / GTF 金融 200，其餘視為
股票，1 張＝1000 股）。

注意：本表是「後端 PnL 金額計算」用的精確 4 碼前綴對照，與
core/position_tracker._detect_multiplier（不同前綴方案、回傳 float、預設 1.0）
語意不同，刻意不合併。本模組不 import 任何 backend 模組，避免循環引用。
"""

# 期貨契約乘數（依代號前綴）
_MULTIPLIERS = {"TXF": 200, "MXF": 50, "EXF": 4000, "GTF": 200}

# 無對應前綴（股票）的預設乘數：1 張 = 1000 股
DEFAULT_MULTIPLIER = 1000


def multiplier_for(symbol: str) -> int:
    """依商品代號回傳乘數；無對應期貨前綴者視為股票，回 1000。"""
    sym = (symbol or "").upper()
    for prefix, mult in _MULTIPLIERS.items():
        if sym.startswith(prefix):
            return mult
    return DEFAULT_MULTIPLIER
