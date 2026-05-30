# LighTrading 後端 Code Review 報告

> 範圍：`lightning_trader/backend/` + `lightning_trader/core/`（API、bridge、broadcaster、RiskManager、ShioajiClient）
> 標的分支：`claude/review-project-structure-HTQRS`
> 日期：2026-05-30
> 重點：實際 bug、執行緒安全、效能、API 一致性。前端只做訪查未深入。

---

## 一、總體評價

**亮點**

- `shared.py` 集中所有共用單例，main 不再散落 global，循環引用控管乾淨。
- `bridge.py` 把 Shioaji 同步 callback 統一橋接到 asyncio queue，邊界清楚。
- `RiskManager` 用單一入口 `pre_order_check`、分 BLOCK/WARNING 兩級，回傳結構好。
- 統一錯誤 envelope `{ code, user_msg }`、前端 `normalizeApiError` 收斂良好。
- 全域 exception handler 不外洩 traceback，CORS 緊縮到 localhost、API 金鑰 masked log，資安基本功到位。
- `pnl_broadcaster` 由 polling 改 event-driven + debounce + heartbeat，設計成熟。
- 測試針對 `RiskManager` 各分支、`SymbolResolver`、`shared_seq`、`pnl_broadcaster` 有單元測試覆蓋。

**主要隱憂（按嚴重度）**

1. `shared.run_in_qt_thread` 名稱與行為不符 → 所有 Shioaji 呼叫實際在 asyncio loop 同步執行，會阻塞 event loop。
2. `RiskManager` 的內部狀態（`_current_prices` / `_recent_orders` / `_order_timestamps`）被 broker callback thread 與 FastAPI thread 同時讀寫，無鎖保護。
3. `/api/place_order` 的 RiskManager 回 WARNING 時與 BLOCK 一律 422，但端點不接受 `confirm=true`，等於把 WARNING 升級成 BLOCK，與註解描述的「前端應彈確認框後重送」流程矛盾。
4. 訂單序號 `_callback_seq` / `_snapshot_seq` 雙執行緒讀寫無 lock，雖然 GIL 保護一般情境，但設計上仍是 race。

---

## 二、嚴重等級分類問題清單

### 🔴 Critical — 影響正確性／可能造成下單／資料異常

#### C1. `run_in_qt_thread` 假名真同步，阻塞 event loop
**位置**：`backend/shared.py:64-69`
```python
async def run_in_qt_thread(func, *args, **kwargs):
    return func(*args, **kwargs)
```
- 註解承諾「將函數丟到 Qt 執行緒環境執行」，實際上就是 sync call。
- 全部 routers 對 Shioaji 的呼叫都走這個包裝，如 `place_order`、`list_positions`、`api.update_status`、`get_order_history` 等，皆會 **同步阻塞 uvicorn 的 event loop**。
- `sync_all` 一次串接 `update_status + get_order_history + list_positions`，期間 WebSocket 完全停擺，連 quote broadcaster 也擋住。
- **建議**：改用 `asyncio.to_thread(func, ...)`（Py 3.9+）丟到 default executor，或建一個固定 worker thread + queue 模擬「Qt 主執行緒」。否則 SLA「<300ms」很難在 7-8 位活躍 WS client 下守得住。

#### C2. RiskManager WARNING 等同 BLOCK
**位置**：`backend/routers/orders.py:134-140`
```python
if not result.passed:
    raise HTTPException(status_code=422, detail={
        "code": "RISK_BLOCK" if result.level.value == "block" else "RISK_WARNING",
        ...
    })
```
- 註解寫「WARNING 也回 422 + warning flag，前端應彈確認框後重送 (帶 confirm=true)」。
- 但 `PlaceOrderRequest` 沒有 `confirm` 欄位、端點也沒有「跳過 RiskManager」分支。前端再送一次仍會被同一 WARNING 擋住。
- 結果：市價單確認、反向確認、價格偏離警告 = 永遠下不出去。
- **建議**：在 `PlaceOrderRequest` 加 `confirm_warning: bool = False`；當收到此 flag 時跳過會回 WARNING 的檢查（或在 RiskManager 端加 `allow_warnings` 參數）。

#### C3. RiskManager 共享狀態未加鎖
**位置**：`core/risk_manager.py:106-110, 124-138, 272-297`
- 寫入者：
  - `_on_tick`（broker callback thread）→ `_current_prices`
  - `_on_fill`（broker callback thread）→ `_order_timestamps`
  - `_on_position_update`（broker callback thread）→ `_current_positions`, `_daily_unrealized_pnl`
- 讀取／修改者：
  - `pre_order_check`（FastAPI thread）→ 讀 `_current_prices`、寫/讀 `_recent_orders`、`_order_timestamps`
- `_check_order_rate` 一邊用 list comprehension 重建、一邊 append，跨 thread 不安全。
- **建議**：用 `threading.Lock`（粗粒度即可，整個 `pre_order_check` 包一把），或把所有 mutation 都丟到 fastapi loop 上用 `call_soon_threadsafe`。

#### C4. `/api/place_order` 商品類型判斷過於粗糙
**位置**：`backend/routers/orders.py:107`
```python
is_stock = len(req.symbol) == 4 and req.symbol.isdigit()
```
- ETF（00xx, 5 碼）、權證（6 碼）、零股、興櫃會被誤判成期貨。
- 走到 `futures_price_type_map` 取得 `FuturesPriceType.LMT` 再送 stock contract 進 `shioaji_client.place_order` 會被 Shioaji reject 或更糟：價格類型錯位。
- **建議**：用 `shioaji_client.get_contract(symbol)` 拿到 contract，由 `contract.security_type` 或類別決定。或在 `core` 提供 `is_stock_symbol(symbol)` 函式統一判斷。

#### C5. 序號生成非執行緒安全
**位置**：`backend/shared.py:36-48`
```python
_callback_seq = _base
def generate_callback_seq() -> int:
    global _callback_seq
    _callback_seq += 1
    return _callback_seq
```
- `generate_callback_seq` 由 `bridge.on_shioaji_order_update`（broker thread）呼叫；
- `generate_snapshot_seq` 由 FastAPI request thread 呼叫。
- 雖然 CPython GIL 讓單次 `+=` 在簡單情境下「看起來」原子，但兩個 thread 對不同變數、且未來若改 PyPy / free-threaded，皆會壞。
- **建議**：用 `itertools.count(start)` + `next()`（thread-safe by GIL 但語意明確），或包 `threading.Lock`。

#### C6. `_get_working_orders_snapshot` 型別與回傳值不符
**位置**：`backend/routers/orders.py:55-83`
```python
async def _get_working_orders_snapshot() -> list:
    ...
    return {"seq_no": shared.generate_order_seq(), "orders": working}
```
- 回傳 `dict`，型別宣告 `list`。不致 runtime 出錯但會誤導靜態檢查與後續使用者。
- **建議**：改 `-> dict`，或定義 `TypedDict` 明確結構。

#### C7. `bridge.on_shioaji_quote` 例外 fallback 用棄用 API
**位置**：`backend/bridge.py:89-95`
```python
else:
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.call_soon_threadsafe(...)
    except:
        pass
```
- `asyncio.get_event_loop()` 在非 main thread + 無 running loop 時於 3.12 起會 deprecation / raise。
- 裸 `except:` 吞掉所有錯誤，含 `KeyboardInterrupt`。
- 而且：在 broker thread 呼叫 `get_event_loop()` 拿到的不是 fastapi 的 loop，後續 `call_soon_threadsafe` 也送錯地方。
- **建議**：完全刪除 fallback；`shared.fastapi_loop` 在 lifespan 啟動後就保證設定，如果為 None 表示尚未啟動，直接 `logger.warning` 並 return 即可。

---

### 🟡 中度 — 影響效能／穩定性／一致性

#### M1. PnL fallback 使用券商靜態 pnl 而不警示
**位置**：`backend/services/pnl_broadcaster.py:96-103`
```python
if cur_price > 0 and cost > 0 and qty > 0:
    ...
else:
    pnl_per_unit = 0
    rt_pnl = pnl_from_broker
```
- 當 `_latest_prices` 沒有此 symbol（尚未訂閱、或 watchdog 拉斷線），退回 broker 提供的靜態 `pnl`，**且不通知前端「這是 stale」**。
- 結果：使用者以為 PnL 即時，其實鎖在最後一次帳務廣播的值。
- **建議**：在 payload 增加 `pnl_stale: bool` 旗標；或在前端 `Panel_Positions` 觀察 `currentPrice == 0` 加灰底。

#### M2. `_pos_cache` global 無鎖、async 函式可被重入
**位置**：`backend/services/pnl_broadcaster.py:28-79`
- 純 asyncio 環境下單 worker 是安全的，但若未來增加更多消費者（例如新加 risk 重算 task）就會 race。
- **建議**：用 `asyncio.Lock()` 包 `_refresh_positions_if_stale`，明示語意。

#### M3. `_periodic_check` 可能瘋狂 emit risk_breach
**位置**：`core/risk_manager.py:140-150`
- `_on_position_update` 觸發 `_periodic_check`，但 `on_position_update` 可能由帳務廣播以高頻觸發。
- 雖然 `trading_enabled = False` 之後就不會再 emit，但 BLOCK 那一瞬間若同時收到 N 個 position update，會 emit N 次 `on_risk_breach`。
- **建議**：用 `_breach_emitted: bool` 邊緣觸發旗標，`reset_daily` 時 clear。

#### M4. `accounts.py:/api/login` 切換 simulation 模式時的競態
**位置**：`backend/routers/accounts.py:56-91`
```python
if getattr(shared.shioaji_client, "_is_connected", False) and shared.shioaji_client.is_simulation == req.simulation:
    return {"status": "success", ..., "already": True}
```
- 若使用者要從 simulation=True 切到 False，會通過上面的 early return 條件失敗 → 進入登入流程；但 `shioaji_client.login` 內部會 `self.api.logout()` 然後重建 `sj.Shioaji(...)`，**舊回呼會被新 client 取代但 `wire_callbacks` 不會重跑**，因為 `_setup_callbacks` 是內部呼叫，bridge 在 main.py 啟動時掛一次的 `_direct_quote_callback = on_shioaji_quote` 在新 client 上會被保留嗎？看 `_setup_callbacks` 不會重設這個屬性，所以實際上會保留。但 `signal_account_update.connect(...)` 之類 connect 一次的 connection 是 connect 到舊 Signal instance，**新 client 重建之後 connect 就失效**。
- **建議**：simulation 切換時 `wire_callbacks()` 應重跑一次；或把 `_setup_callbacks` 改為連同 bridge 也重 wire。

#### M5. `list_positions` 對每個帳號都呼叫 `update_status`
**位置**：`core/shioaji_client.py:309-340`
- `pnl_broadcaster` 每 1s TTL 都會呼叫一次 `list_positions`（C1 阻塞 loop 已述）。
- 多帳號使用者下，每次 `list_positions` 內含 N 次 `api.update_status(acc)` + N 次 `list_positions(acc)`。
- **建議**：把帳號清單 cache 起來（登入後固定），並考慮把 `update_status` 與 `list_positions` 拆開呼叫頻率。

#### M6. `place_order` 取 positions 用於 RiskManager 又再撈一次
**位置**：`backend/routers/orders.py:118-124`
- 為了餵 `pre_order_check` 的 `position_qty / position_direction`，每次下單前都打一次 `list_positions`（同時阻塞 loop）。
- 但 `RiskManager._current_positions` 已經由 `_on_position_update` 維護同樣資料。
- **建議**：去掉這個額外 `list_positions`，直接讓 `pre_order_check` 從自己內部 `_current_positions` 拿（已有 fallback 邏輯在 `_check_max_position:255-261`）。

#### M7. WebSocket 缺 heartbeat / 訂閱列表 / 客戶端識別
**位置**：`backend/main.py:167-210`
- `active_connections: set[WebSocket]` 只有「全有全無」廣播，無法 per-client 過濾。
- 沒處理 ping/pong，依賴 TCP 半開連線會被 watchdog 偵測（quote_broadcaster send timeout 0.1s）但時間長。
- 一個客戶端訂閱了什麼 symbol 完全不追蹤，所有 quotes 都廣播給所有 client。如果未來想多商品分流（如 chart panel only），就要重做。
- **建議**：把 connection wrap 成 `ConnectionInfo {ws, subscribed_symbols: set}`；server 每 30s 送一個 `{"type": "ping"}` 心跳。

#### M8. `rate_limit._buckets` 無 GC
**位置**：`backend/rate_limit.py:20`
- 每個 unique `(path, client_host)` 都 forever 留在記憶體；單機自用不會炸，但行為值得記錄。
- **建議**：起一個背景 task 每 5 分鐘清空 `_buckets` 裡所有 `bucket` empty 的 key（一行）。

#### M9. `Config.SIMULATION` 預設為 False
**位置**：`core/config.py:19`
```python
SIMULATION = os.getenv("SHIOAJI_SIMULATION", "False").lower() in ["true", "1", "yes"]
```
- 註解承認「預設改為 False (正式環境) 以讀取真實部位」——但 README 與 `.env.example` 都教使用者「先模擬後實單」。
- 一旦使用者忘記設定 `SHIOAJI_SIMULATION=true` 又自動登入（`main.py:_auto_login`），會直接連到實單，且前端 LIVE 紅 banner 是依賴 `is_simulation` 旗標。
- **建議**：預設改回 `True`，並在 README 強調如何切換；或在 `_auto_login` 前再次警告。

#### M10. `cancel_all` / `flatten_position` 例外處理不一致
**位置**：`backend/routers/orders.py:178-212`
- `cancel_all` 失敗回 plain string `"刪單過程遭遇錯誤"`；
- `flatten` 失敗回 envelope `{code, user_msg}`。
- 前端 `normalizeApiError` 兩種都吃得下，但語意不齊。
- **建議**：全面改成 envelope（global handler 已會處理未捕捉例外，但這裡是顯式 raise，全部統一）。

---

### 🟢 改善建議 — 可讀性／設計／長期維護

#### S1. 直接存取 `_is_connected` 私有屬性
- `main.py:181`、`accounts.py:56,211`、`pnl_broadcaster.py:153` 都讀 `shioaji_client._is_connected`。
- **建議**：在 `ShioajiClient` 加一個 `@property def is_connected`，封裝判斷邏輯（甚至可加「最近 N 秒有收 tick」的判斷）。

#### S2. `bridge.py` 內 `from backend.services import pnl_broadcaster as pb` 寫在 callback 內部
- 每筆成交都重新 import 一次 module。Python 有快取所以不慢，但語意鬆散。
- **建議**：移到檔案頂層 import，或重構為 event bus 訂閱。

#### S3. `bridge.on_shioaji_quote` 太重
- 一個 callback 內：copy、雙路檢查、type coerce、emit event bus、放 queue。在高頻 tick 下都跑在 broker thread。
- **建議**：bridge 只負責格式化 + 放 queue；event bus emit 移到 broadcaster 那一側。

#### S4. `PlaceOrderRequest.symbol` 長度上限 12 可能不夠
- 選擇權代碼有 8-13 碼（如 TXO20000I5），12 是邊界。
- **建議**：放寬到 16 或拿掉上限（後續驗證在 contract resolve 階段）。

#### S5. `routers/orders.py:54` 註解寫「呼叫 update_status() 強制同步最新狀態」但只在 `_get_working_orders_snapshot` 用
- `update_order`、`flatten`、`reverse` 都沒呼叫 `update_status`，可能拿到舊狀態。
- **建議**：在 `_get_working_orders_snapshot` 共用工具同等級加 `_sync_status()`，所有破壞性操作前後都用。

#### S6. `pnl_broadcaster._PNL_MULTIPLIERS` 硬編碼
- 漏掉 OXF、JPY、XAF 等品種；default 1000 對股票勉強對，對其他期貨會錯。
- **建議**：改從 `contract.multiplier` 動態取得（Shioaji `Contract` 物件有此欄位），fallback 才用 dict。

#### S7. 測試覆蓋
- ✅ `RiskManager` 各分支、`SymbolResolver`、`shared_seq`、`pnl_broadcaster` 有測試。
- ❌ `bridge.py` 沒有測試（最關鍵的 thread 邊界邏輯）。
- ❌ `routers/orders.py:place_order` 沒有端對端測試，特別是 RISK_WARNING 的回流。
- ❌ `OrderManager.on_order_status_callback` 的狀態機沒測試。
- **建議**：補一個 `test_bridge.py` 用 fake `fastapi_loop` + fake `Queue` 驗證 bridge 在不同 quote 格式下的 enqueue 行為。

#### S8. `core/__init__.py` 內 `create_trading_engine`（未讀）
- 多處對 `engine.risk_manager`、`engine.smart_order_engine`、`engine.event_bus` 取屬性，但 trading engine 的組裝邏輯應該值得寫一段 docstring 在 README 或 ARCHITECTURE.md 描述。

#### S9. Daily reset 用本地時間
- `main.py:_daily_risk_reset` 用 `datetime.now()`（無 tz），假設台北時間。若 Docker container 用 UTC 會在 12:00 UTC 重置。
- **建議**：改 `datetime.now(tz=ZoneInfo("Asia/Taipei"))`。

#### S10. `flatten_position` 註解寫 "atomic-ish"
- 真實情況是：先撤單 → 再送反向市價，中間若連線斷或交易所拒絕，可能撤單成功但平倉失敗。
- **建議**：在 response 加 `cancelled: int, flatten_sent: bool` 兩個欄位，前端能呈現中間狀態。

---

## 三、各模組逐一評論（摘要）

| 模組 | 主要評語 |
|---|---|
| `main.py` | 結構清楚；唯獨 `_auto_login` 與 LIVE 模式互動有 M9 風險。 |
| `shared.py` | 集中得好；run_in_qt_thread (C1) 與 seq (C5) 是兩大坑。 |
| `bridge.py` | 邊界清晰；callback 太重 (S3)、fallback 用棄用 API (C7)。 |
| `rate_limit.py` | 簡潔，本機自用足夠 (M8)。 |
| `routers/orders.py` | RiskManager 流程不完整 (C2)、type 判斷脆弱 (C4)、回傳型別誤導 (C6)、額外 list_positions (M6)。 |
| `routers/accounts.py` | sync_all 阻塞 loop 較嚴重 (C1)、simulation 切換重連 (M4)。 |
| `routers/risk.py` | 乾淨；唯獨直接讀 `rm._daily_realized_pnl` 私有欄位。 |
| `routers/smart.py` | 缺異常處理，`add_trailing_stop`/`add_mit` 失敗會 raise 全域 handler 接走。 |
| `routers/user_settings.py` | 簡單可靠；可加檔案大小上限避免 DoS。 |
| `routers/health.py` | 設計恰當。 |
| `services/quote_broadcaster.py` | 設計成熟，timeout=0.1s 防呆是亮點。 |
| `services/pnl_broadcaster.py` | event-driven 設計好；fallback 透明度 (M1) 與 multiplier (S6) 可改。 |
| `core/risk_manager.py` | 整合 OrderValidator+RiskManager 重構成功；唯獨 thread safety (C3) 必須補。 |
| `core/order_manager.py` | 完備；但 routers 都沒用它（bridge → WebSocket 是另一條路），思考是否要整合。 |
| `core/shioaji_client.py` | 重連與 watchdog 設計考量周到；login 切換 simulation 時 callback 重 wire (M4) 要處理。 |
| `core/symbol_resolver.py` | 簡潔正確。 |
| `core/config.py` | SIMULATION 預設 (M9) 風險偏高。 |

---

## 四、測試覆蓋評估

```
core/risk_manager.py        ★★★★☆  分支完整，缺 reverse_confirm / price_deviation 測試
core/symbol_resolver.py     ★★★★★
core/order_manager.py       ★☆☆☆☆  幾乎沒測試
core/shioaji_client.py      ☆☆☆☆☆  CI 不能跑 shioaji；至少可 mock Signal 測 callback wire 邏輯
backend/bridge.py           ☆☆☆☆☆  最該補測試的地方
backend/services/pnl        ★★★☆☆
backend/routers/*           ☆☆☆☆☆  缺端對端 testclient 測試
```

---

## 五、建議的修補優先順序

| 優先 | 項目 | 狀態 |
|---|---|---|
| P0 | C2 `confirm_warning` flag — 否則 WARNING 流程根本不能用 | ✅ 已修補 |
| P0 | C1 `run_in_qt_thread` 改 `asyncio.to_thread` — 直接受益於延遲 SLA | ✅ 已修補 |
| P0 | C4 商品類型判斷改用 contract 元資料 | ✅ 已修補 |
| P1 | C3 RiskManager 加 Lock | ✅ 已修補 |
| P1 | M4 simulation 切換重 wire callbacks | ✅ 已修補（login 成功後重 wire） |
| P1 | M6 移除重複 list_positions | ✅ 已修補（改讀 RiskManager 內部狀態） |
| P2 | C5 序號改 itertools.count thread-safe | ✅ 已修補 |
| P2 | C6 回傳型別宣告改 `-> dict` | ✅ 已修補 |
| P2 | C7 移除棄用 fallback、`asyncio.get_event_loop` | ✅ 已修補 |
| P2 | M1 PnL stale 旗標 | ✅ 已修補 |
| P2 | M3 risk_breach 邊緣觸發 | ✅ 已修補（`_breach_emitted`） |
| P2 | S1 `is_connected` property | ✅ 已修補 |
| P2 | S4 PlaceOrderRequest symbol max_length 16 | ✅ 已修補 |
| P2 | S9 daily reset 用 Asia/Taipei | ✅ 已修補 |
| P3 | S6 multiplier 動態取自 contract、M7 ws subscription、S7 補測試 | 未做（建議下個 sprint） |

## 六、新增測試

- `test_risk_manager.py`：新增 4 個測試
  - `test_allow_warnings_passes_market_order`
  - `test_allow_warnings_does_not_bypass_block`
  - `test_allow_warnings_passes_reverse`
  - `test_breach_emitted_only_once`
- `test_shared_seq.py`：新增 `test_seq_thread_safe_under_concurrent_writes`（8 threads × 500 次 = 4000 唯一序號）
- `test_pnl_broadcaster.py`：新增 `test_pnl_stale_flag_set_when_price_missing`、`test_pnl_stale_flag_false_when_price_available`

完整測試：**31/31 passed**（基線 24 + 新增 7）。

---

## 七、整體結論

專案結構乾淨、抽象到位、Chinese docstring 標示清楚，遠優於同類個人專案的常見「上千行 main.py」狀態。最大兩個問題集中在 **(a) async/sync 邊界處理不真實**（`run_in_qt_thread` 是 noop、Shioaji 同步呼叫實際阻塞 event loop）與 **(b) RiskManager WARNING 流程斷裂**（前端無法 confirm-and-resend）。建議先針對 P0 三項做 patch，其餘可隨 sprint 慢慢吸收。

對單人自用日內交易終端而言，目前的程式碼品質與測試覆蓋已能上線使用；上述問題多半在「多 WebSocket client + 高頻 tick + 多商品同時下單」的壓力情境才會顯現。
