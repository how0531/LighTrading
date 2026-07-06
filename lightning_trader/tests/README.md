# LighTrade Tests

## 跑法

```bash
cd lightning_trader
python3 -m pytest tests/ -q
```

依賴：`pytest`、`httpx`（TestClient 用），加上 backend 的 requirements
（fastapi / uvicorn / pydantic / python-dotenv / python-multipart）。
**不需要真的 shioaji** —— 整合測試用 `fake_shioaji.py` 替身 SDK。

## 涵蓋範圍

### 整合（FastAPI TestClient + fake shioaji）

| 檔案 | 內容 |
|---|---|
| `test_api_integration.py` | 市價單 409 confirm 流程、風控封鎖（place/update/reverse）、股票 flatten NameError 回歸、智慧單觸發風控（開倉封鎖 / 保護性停損放行）、日虧損熔斷（unrealized + journal realized 餵入）、API token 認證 |
| `fake_shioaji.py` | 替身 SDK：constants / Contracts / place_order 紀錄 / positions 注入 |

### 單元（離線，importlib 直載繞過 shioaji 依賴）

| 檔案 | 內容 |
|---|---|
| `test_smart_order_engine.py` | MIT / 移停 / OCO / Bracket 觸發邏輯、one-shot、SQLite 持久化 re-arm |
| `test_risk_manager.py` | `pre_order_check` 全分支：BLOCK / WARNING / skip_warnings |
| `test_symbol_resolver.py` | 期貨 tick.code → user-facing symbol 映射；大小寫無關；執行緒安全 |
| `test_shared_seq.py` | `callback_seq` / `snapshot_seq` 兩條 seq 流互不影響 |
| `test_pnl_broadcaster.py` | 即時 PnL 計算邏輯：多空、乘數、missing-price fallback |
| `test_equity_curve.py` | FIFO 已實現損益曲線 |
| `test_trade_journal.py` | SQLite journal 落地 / 查詢 / migration |
| `test_trade_stats.py` / `test_latency_tracker.py` / `test_alert_dispatcher.py` | 統計 / 延遲量測 / webhook |

## 未來擴充

- Playwright E2E：登入 → 訂閱 → 下單 → 刪單 → 平倉
- 外部下單壓測：在另一個 Shioaji session 連續送 30 筆 → 驗證本地 P95 < 500ms 同步
