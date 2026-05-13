# LighTrade Tests

## 跑法

```bash
cd lightning_trader
python3 -m pytest tests/ -q
```

依賴：`pytest`、`fastapi`（已是 backend 依賴）。

## 涵蓋範圍（離線、純單元）

| 檔案 | 對應 Sprint | 內容 |
|---|---|---|
| `test_symbol_resolver.py` | S0-4 | 期貨 tick.code → user-facing symbol 映射；大小寫無關；執行緒安全 |
| `test_shared_seq.py` | S0-7 | `callback_seq` / `snapshot_seq` 兩條 seq 流互不影響 |
| `test_pnl_broadcaster.py` | S0-1 | 即時 PnL 計算邏輯：多空、乘數、missing-price fallback |

## 不在 pytest 範圍（手動執行）

| 檔案 | 用途 |
|---|---|
| `latency_check.py` | 端到端延遲量測：tick → PnLUpdate 推播 / `/api/sync_all` RTT。需要 backend + Shioaji 已登入 |

```bash
pip install websockets httpx
python3 tests/latency_check.py --symbol TXFR1 --secs 30
```

## 未來擴充

- Playwright E2E：登入 → 訂閱 → 下單 → 刪單 → 平倉
- 外部下單壓測：在另一個 Shioaji session 連續送 30 筆 → 驗證本地 P95 < 500ms 同步
