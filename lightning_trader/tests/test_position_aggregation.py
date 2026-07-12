"""
手動下單「部位聚合」修復測試（A1）

驗證 place_order 端點在計算部位上限與 reduce-only 豁免時，改用有號淨部位
net_position_of() 聚合同商品所有列（多帳號、現股買+融資買、一多一空…），
而非之前只取 next() 抓到的第一列。

覆蓋兩個資金缺陷：
  1. 多列同向 → 之前用第一列當基數，真實淨部位超過上限的開倉單被放行；
     修後以聚合淨部位計算 → RISK_BLOCK。
  2. 異向多列 → 之前第一列可能是反符號，開倉單被 pre_order_check 誤判為
     reduce-only 而豁免 trading_enabled / 日虧損熔斷；修後以真實淨部位判定，
     開倉單在熔斷後仍被擋，而真正的減倉單仍正確豁免。

使用與 test_api_integration 相同的 fake shioaji + FastAPI TestClient，
直接驅動真正的 /api/place_order 路由（端到端）。本檔可獨立執行
（standalone），故自帶完整 fake 安裝與 client 建立；在全套執行時與
test_api_integration 共用同一個已載入的 backend（install 冪等、環境變數以
setdefault 保護，不覆蓋先載入模組的設定）。
"""
import os
import sys
import tempfile

# ── 必須在 import backend / core 之前安裝 fake shioaji ──
_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

import fake_shioaji  # noqa: E402
fake_shioaji.install()

_TMP = tempfile.mkdtemp(prefix="lightrade-posagg-")
# setdefault：若 test_api_integration 已先設定並載入 backend，沿用其設定，
# 不覆蓋（backend 於 import 時讀取，重設也無效且會製造混淆）。
os.environ.setdefault("LIGHTRADE_LOG_DIR", "")
os.environ.setdefault("LIGHTRADE_SMART_ORDERS_DB", os.path.join(_TMP, "smart.db"))
os.environ.setdefault("LIGHTRADE_JOURNAL_DB", os.path.join(_TMP, "journal.db"))
os.environ.pop("LIGHTRADE_API_TOKEN", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import main as backend_main  # noqa: E402
from backend import shared  # noqa: E402
from backend import rate_limit  # noqa: E402
from fake_shioaji import Action, FakePosition  # noqa: E402

client = TestClient(backend_main.app)


def _fake_api():
    return shared.shioaji_client.api


def _rm():
    return shared.engine.risk_manager


@pytest.fixture(autouse=True)
def _reset_state():
    """每個測試前重置整合測試共用的 backend 狀態。

    統一邏輯已收斂到 tests/conftest.py 的 reset_backend_state()（見該處
    完整清單）；本檔沿用該共用邏輯，不再各自複製那一大段 reset。"""
    from conftest import reset_backend_state
    reset_backend_state()
    yield


# ─── 1. 多列同向聚合 → 真實淨部位超過上限被擋 ─────────────────

def test_multi_row_same_symbol_aggregated_net_blocks_over_cap():
    """同商品兩列各 Buy 8（例：現股買 + 融資買）→ 淨 16 口。
    上限 10，再下 Buy 1 → 淨 17 超過上限，必須 RISK_BLOCK。
    修前只讀第一列（8 口）→ 淨算成 9 ≤ 10 → 會被放行超額建倉。"""
    _rm().update_config(max_position_per_symbol=10)
    _fake_api().positions = [
        FakePosition("2330", 8, Action.Buy),
        FakePosition("2330", 8, Action.Buy),
    ]
    r = client.post("/api/place_order", json={
        "symbol": "2330", "price": 500.0, "action": "Buy", "qty": 1,
        "price_type": "LMT",
    })
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "RISK_BLOCK"
    assert "部位上限" in detail["user_msg"]
    assert not _fake_api().placed_orders  # 超額建倉單不得送出


def test_single_row_below_cap_still_passes():
    """對照組（sanity）：只有單列 Buy 8、上限 10，再下 Buy 1 → 淨 9 ≤ 10 放行。
    證明前一測試的 BLOCK 來自「多列聚合」而非上限本身太緊。"""
    _rm().update_config(max_position_per_symbol=10)
    _fake_api().positions = [FakePosition("2330", 8, Action.Buy)]
    r = client.post("/api/place_order", json={
        "symbol": "2330", "price": 500.0, "action": "Buy", "qty": 1,
        "price_type": "LMT",
    })
    assert r.status_code == 200, r.text
    assert len(_fake_api().placed_orders) == 1


# ─── 2. 異向多列 → 開倉單不得被誤判 reduce-only 而豁免熔斷 ──────

def test_opposite_direction_multirow_open_order_not_exempt_during_halt():
    """第一列 Sell 3、第二列 Buy 8 → 真實淨 +5（淨多單）。
    熔斷（trading_enabled=False）後再下 Buy 2（加碼、開倉方向）：
      修前：next() 取到第一列 Sell 3 → pre_order_check 以 net -3 判定，
            Buy 2 反向且不超量 → 誤判 reduce-only → 豁免熔斷 → 放行加碼。
      修後：聚合淨 +5（Buy）→ Buy 2 為同向加碼、非 reduce-only → 被熔斷擋下。"""
    _fake_api().positions = [
        FakePosition("2330", 3, Action.Sell),   # 反符號、且被 next() 先抓到
        FakePosition("2330", 8, Action.Buy),
    ]
    _rm().config.trading_enabled = False

    r = client.post("/api/place_order", json={
        "symbol": "2330", "price": 500.0, "action": "Buy", "qty": 2,
        "price_type": "LMT", "confirm": True,
    })
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "RISK_BLOCK"
    assert not _fake_api().placed_orders  # 熔斷後開倉加碼單不得送出


def test_true_reduce_only_still_allowed_during_halt_with_multirow():
    """相同的異向多列（真實淨 +5 多單），熔斷後下 Sell 2（真正減倉、不超淨部位）
    必須仍放行 —— 修復以「真實淨部位」判定 reduce-only，不因聚合而過度封鎖出場。"""
    _fake_api().positions = [
        FakePosition("2330", 3, Action.Sell),
        FakePosition("2330", 8, Action.Buy),
    ]
    _rm().config.trading_enabled = False

    r = client.post("/api/place_order", json={
        "symbol": "2330", "price": 495.0, "action": "Sell", "qty": 2,
        "price_type": "LMT", "confirm": True,  # 反向確認 warning 已由使用者確認
    })
    assert r.status_code == 200, r.text
    assert len(_fake_api().placed_orders) == 1
    sent = _fake_api().placed_orders[0]
    assert sent["code"] == "2330" and "Sell" in sent["action"]
