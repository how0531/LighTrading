"""
test_contract_specs.py — 後端乘數單一真相源（B1 重構守門）

鎖定 contract_specs.multiplier_for 的行為，確保從 pnl_broadcaster / reports /
equity_curve 收斂後值不漂移。
"""
from backend.services.contract_specs import multiplier_for, DEFAULT_MULTIPLIER


def test_futures_prefixes():
    assert multiplier_for("TXF") == 200
    assert multiplier_for("MXF") == 50
    assert multiplier_for("EXF") == 4000
    assert multiplier_for("GTF") == 200


def test_full_contract_codes_match_by_prefix():
    # 帶到期月的完整代號仍依前綴判定
    assert multiplier_for("TXF202509") == 200
    assert multiplier_for("MXFG5") == 50


def test_case_insensitive():
    assert multiplier_for("txf202509") == 200
    assert multiplier_for("mxf") == 50


def test_stock_defaults_to_1000():
    assert multiplier_for("2330") == 1000
    assert multiplier_for("0050") == 1000
    assert multiplier_for("AAPL") == 1000


def test_empty_or_none_is_default():
    assert multiplier_for("") == DEFAULT_MULTIPLIER
    assert multiplier_for(None) == DEFAULT_MULTIPLIER


def test_matches_legacy_wrappers():
    # 薄 wrapper 應與單一真相源一致。reports.py 在 module 層 import shioaji，
    # 無 SDK 環境無法 import，故此處只交叉驗不依賴 shioaji 的兩個 wrapper。
    from backend.services.pnl_broadcaster import _get_multiplier
    from backend.services.equity_curve import _multiplier_for as equity_mult
    for sym in ("TXF202509", "MXF", "EXF", "GTF", "2330", "", "xyz"):
        expected = multiplier_for(sym)
        assert _get_multiplier(sym) == expected
        assert equity_mult(sym) == expected
