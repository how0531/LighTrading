# LighTrading 系統流程圖

> 範圍：`lightning_trader/backend/` + `core/` + `frontend/`
> 反映 2026-05-30 code review 修補後的最新行為
> 所有圖以 Mermaid 撰寫，可在 GitHub / VSCode / Obsidian 直接渲染

---

## 1. 系統架構總覽

```mermaid
graph TB
    subgraph Browser["瀏覽器 (Electron / Chrome)"]
        UI[React 19 + Vite<br/>Dashboard / DOM / Panels]
        Ctx[Contexts<br/>Trading / Settings / Toast]
        AxClient[apiClient<br/>axios → /api]
        WSClient[WebSocket<br/>/ws/quotes]
    end

    subgraph Backend["Backend (FastAPI + uvicorn, 127.0.0.1:8000)"]
        Main[main.py<br/>lifespan + WS endpoint]
        subgraph Routers
            ROrd[orders.py]
            RAcc[accounts.py]
            RRisk[risk.py]
            RSmart[smart.py]
            RUS[user_settings.py]
            RH[health.py]
        end
        subgraph Services
            QB[quote_broadcaster<br/>asyncio task]
            PB[pnl_broadcaster<br/>event-driven asyncio task]
        end
        Bridge[bridge.py<br/>Shioaji callback → Queue]
        Shared[shared.py<br/>單例 / seq / loop ref]
        RL[rate_limit.py]
    end

    subgraph Core["lightning_trader/core/"]
        Eng[TradingEngine]
        SJC[ShioajiClient<br/>+ SymbolResolver]
        RM[RiskManager]
        OM[OrderManager]
        SOE[SmartOrderEngine]
        EB[EventBus<br/>on_tick / on_fill / ...]
    end

    subgraph External["外部"]
        Shioaji["Shioaji SDK<br/>(永豐金 API)"]
        TWSE[(台灣證交所 / 期交所)]
    end

    UI <--> Ctx
    Ctx --> AxClient
    Ctx --> WSClient
    AxClient -.HTTP.-> ROrd & RAcc & RRisk & RSmart & RUS & RH
    WSClient <-.WS.-> Main

    ROrd & RAcc & RSmart --> Shared
    Shared --> Eng
    Eng --> SJC & RM & OM & SOE & EB
    Bridge --> Shared
    SJC -.callback.-> Bridge
    EB -.tick.-> RM & PB
    EB -.fill.-> RM & OM
    QB -.put.-> WSClient
    PB -.put.-> WSClient

    SJC <--> Shioaji
    Shioaji <--> TWSE

    style Browser fill:#e1f5fe
    style Backend fill:#fff3e0
    style Core fill:#f3e5f5
    style External fill:#ffebee
```

---

## 2. 啟動 Lifespan 序列

```mermaid
sequenceDiagram
    autonumber
    participant U as uvicorn
    participant M as main.py
    participant LS as lifespan
    participant Sh as shared
    participant Br as bridge
    participant QB as quote_broadcaster
    participant PB as pnl_broadcaster
    participant DL as _daily_risk_reset
    participant AL as _auto_login

    U->>M: import & 初始化
    M->>M: create_trading_engine()
    M->>Sh: shared.engine = engine<br/>shared.shioaji_client = engine.client
    M->>Br: wire_callbacks() — 掛 5 個 Shioaji signal
    Note over Br: client.signal_order_update.connect(on_shioaji_order_update)<br/>... + event_bus.on_tick.connect(on_shioaji_tick_for_pnl)<br/>+ client._direct_quote_callback = on_shioaji_quote

    U->>LS: 進入 lifespan
    LS->>Sh: shared.fastapi_loop = asyncio.get_running_loop()
    LS->>QB: asyncio.create_task(quote_broadcaster())
    LS->>PB: asyncio.create_task(pnl_broadcaster())
    LS->>AL: asyncio.create_task(_auto_login())
    LS->>DL: asyncio.create_task(_daily_risk_reset())

    par 背景任務啟動
        QB-->>QB: await shared.quotes_to_broadcast.get()
    and
        PB-->>PB: await _tick_event.wait() or heartbeat
    and
        AL-->>AL: sleep 2s → 檢查 .env → shared.shioaji_client.login
    and
        DL-->>DL: 計算下次 04:00 Asia/Taipei → sleep until
    end

    LS-->>U: yield (服務 ready)
    Note over U: 後續處理 HTTP/WS 請求...
```

---

## 3. 登入流程（含 simulation 切換）

```mermaid
sequenceDiagram
    autonumber
    actor User as 使用者
    participant FE as React (LoginPanel)
    participant API as accounts.login
    participant RL as rate_limit
    participant Sh as shared
    participant SJC as ShioajiClient
    participant SJ as Shioaji SDK
    participant Br as bridge
    participant PB as pnl_broadcaster

    User->>FE: 輸入 api_key/secret (或留空走 .env)
    FE->>API: POST /api/login {api_key, secret_key, simulation, ca_*}
    API->>RL: check_rate_limit (3 次/分鐘)
    alt 已登入且 simulation 相同
        API-->>FE: {success, already: true}
    else 重新登入
        API->>Sh: run_in_qt_thread(SJC.login, ...)
        Sh->>SJC: login() — 透過 asyncio.to_thread
        opt simulation 切換
            SJC->>SJ: api.logout()
            SJC->>SJC: 重建 sj.Shioaji(simulation=...)<br/>並 _setup_callbacks()
        end
        SJC->>SJ: api.login(key, secret)
        SJ-->>SJC: ok / fail
        alt 登入成功
            SJC->>SJ: list_accounts() → 設 active_stock/futopt
            SJC->>SJC: _is_connected = True<br/>signal_login_status.emit(True)
            SJC-->>Sh: True
            Sh-->>API: True
            API->>Br: wire_callbacks() — 修補後新增<br/>(simulation 切換後新 Signal 需重連)
            API->>PB: asyncio.create_task(subscribe_position_contracts())
            PB->>SJC: list_positions → 取 symbols
            loop 每個持倉商品
                PB->>SJC: subscribe_background(sym)
            end
            API-->>FE: {status: success}
        else 失敗
            SJC-->>API: False
            API-->>FE: 422 / 400 + {code, user_msg}
        end
    end
```

---

## 4. 下單流程（含 RiskManager + WARNING 確認）

```mermaid
flowchart TD
    Start([使用者按下下單]) --> FE1[Trading.placeOrder<br/>confirm_warning = false]
    FE1 --> POST1[POST /api/place_order]

    POST1 --> RL[rate_limit<br/>5 req/sec/host]
    RL -->|超限| E429[429<br/>RATE_LIMITED]
    RL -->|通過| GetC[run_in_qt_thread<br/>SJC.get_contract symbol]

    GetC -->|None| E404[404<br/>SYMBOL_NOT_FOUND]
    GetC -->|stock| MapS[stock_price_type_map]
    GetC -->|futures/options| MapF[futures_price_type_map]
    MapS --> RMCheck
    MapF --> RMCheck

    RMCheck[RiskManager.pre_order_check<br/>allow_warnings=false] --> RMRes{result.level}
    RMRes -->|OK| Place[run_in_qt_thread<br/>SJC.place_order]
    RMRes -->|BLOCK| E422B[422<br/>RISK_BLOCK]
    RMRes -->|WARNING| E422W[422<br/>RISK_WARNING + level=warning]

    E422W --> Confirm{前端跳確認框}
    Confirm -->|使用者確認| Retry[POST /api/place_order<br/>confirm_warning = true]
    Confirm -->|取消| Abort([取消])
    Retry --> RL

    Place --> Trade{trade 物件?}
    Trade -->|有| Snap[_get_working_orders_snapshot]
    Trade -->|None| E400[400<br/>ORDER_FAILED]
    Snap --> Done([200 success + 委託快照])

    style RMCheck fill:#fff3e0
    style E422W fill:#ffe082
    style E422B fill:#ef9a9a
    style E429 fill:#ef9a9a
    style E404 fill:#ef9a9a
    style E400 fill:#ef9a9a
    style Done fill:#a5d6a7
```

### RiskManager.pre_order_check 內部分支

```mermaid
flowchart TD
    Entry([pre_order_check]) --> WL{取得 _lock}
    WL --> P0[0. qty>0 & price>=0]
    P0 -->|fail| B[BLOCK]
    P0 --> P1[1. trading_enabled]
    P1 -->|fail| B
    P1 --> P2[2. 日虧損上限]
    P2 -->|fail| B
    P2 --> P3[3. 部位上限<br/>用淨有號 qty]
    P3 -->|fail| B
    P3 --> P4[4. 下單頻率 5/sec]
    P4 -->|fail| B
    P4 --> P5[5. 重複委託 500ms]
    P5 -->|fail| B
    P5 --> P6[6. 價格偏離 2%<br/>WARNING]
    P6 -->|fail + !allow_warnings| W[WARNING]
    P6 -->|fail + allow_warnings| P7
    P6 -->|pass| P7
    P7[7. 市價單確認<br/>WARNING] -->|fail + !allow_warnings| W
    P7 -->|fail + allow_warnings| P8
    P7 -->|pass| P8
    P8[8. 反向加碼確認<br/>WARNING] -->|fail + !allow_warnings| W
    P8 -->|fail + allow_warnings| Rec
    P8 -->|pass| Rec
    Rec[_record_order<br/>放進 _recent_orders] --> Ok[OK]

    style W fill:#ffe082
    style B fill:#ef9a9a
    style Ok fill:#a5d6a7
```

---

## 5. 即時報價流程（Shioaji → WebSocket）

```mermaid
sequenceDiagram
    autonumber
    participant SJ as Shioaji SDK<br/>(broker thread)
    participant SJC as ShioajiClient
    participant EB as EventBus
    participant Br as bridge.on_shioaji_quote
    participant Q as shared.quotes_to_broadcast<br/>(asyncio.Queue)
    participant QB as quote_broadcaster<br/>(asyncio task)
    participant FE as 前端 WebSocket

    Note over SJ: 交易所推送 tick
    SJ->>SJC: _on_tick_fop(exchange, tick)
    SJC->>SJC: symbol = SymbolResolver.canonical(tick.code)
    SJC->>SJC: _latest_prices[symbol] = tick.close<br/>last_message_time = now()
    SJC->>EB: event_bus.on_tick.emit(symbol, tick_data)
    EB-->>RM: RiskManager._on_tick → _current_prices[symbol] = price
    EB-->>PB: pnl_broadcaster.on_tick_event → _tick_event.set()
    SJC->>Br: _direct_quote_callback(quote_dict)
    Br->>Br: 格式化 Tick / BidAsk
    Br->>Q: fastapi_loop.call_soon_threadsafe(<br/>queue.put_nowait, item)

    Note over QB: 主迴圈
    QB->>Q: await queue.get()
    Q-->>QB: quote_item
    par 廣播給每個 ws client
        QB->>FE: wait_for(send_text, timeout=0.1)
    end
    Note over QB: 任一 send 失敗 / timeout<br/>→ active_connections.discard(ws)
    FE->>FE: TradingContext 更新 DOM / Tick / Chart
```

---

## 6. PnL 廣播流程（event-driven + debounce + heartbeat）

```mermaid
stateDiagram-v2
    [*] --> Wait

    state Wait {
        [*] --> Listening
        Listening: await _tick_event.wait()<br/>timeout=1.5s heartbeat
    }

    Wait --> Debounce: tick 來了
    Wait --> Compute: heartbeat 逾時（無 tick）

    state Debounce {
        [*] --> Clear1
        Clear1: _tick_event.clear()
        Clear1 --> Sleep
        Sleep: await asyncio.sleep(100ms)
        Sleep --> Clear2
        Clear2: _tick_event.clear()<br/>(合併 debounce 期間多筆 tick)
    }

    Debounce --> Compute

    state Compute {
        [*] --> ChkConn
        ChkConn: client._is_connected?
        ChkConn --> ChkWS: yes
        ChkConn --> [*]: no (continue)
        ChkWS: 有 active_connections?
        ChkWS --> Refresh: yes
        ChkWS --> [*]: no (continue)
        Refresh: _refresh_positions_if_stale<br/>(TTL=1s 或 forced)
        Refresh --> Calc
        Calc: _compute_pnl_payload<br/>(含 pnl_stale 旗標)
        Calc --> Bcast
        Bcast: 廣播給所有 WS client
    }

    Compute --> Wait

    note right of Debounce
        on_fill_event 觸發時:
        _invalidate_event.set()
        _tick_event.set()
        ⇒ 立即重抓持倉並重算
    end note
```

### PnL 計算（per position）

```mermaid
flowchart LR
    P[position] --> GetPrice[latest_prices.get symbol]
    GetPrice -->|有價| Calc[sign * cur_price - cost<br/>* qty * multiplier]
    GetPrice -->|無價| Fallback[broker pnl<br/>pnl_stale=True]
    Calc --> RT[realtimePnl]
    Fallback --> RT
    RT --> Acc[total_pnl 累加]

    style Fallback fill:#ffe082
    style Calc fill:#a5d6a7
```

---

## 7. 訂單／成交回報流程

```mermaid
sequenceDiagram
    autonumber
    participant SJ as Shioaji SDK<br/>(broker thread)
    participant SJC as ShioajiClient
    participant Br as bridge
    participant Sh as shared
    participant EB as EventBus
    participant OM as OrderManager
    participant RM as RiskManager
    participant PB as pnl_broadcaster
    participant Q as quotes_to_broadcast
    participant QB as quote_broadcaster
    participant FE as 前端 WS

    SJ->>SJC: on_order_status(state, msg)
    Note over SJC: 若 state 含 "Deal"<br/>→ _deal_prices[ordno] = price
    SJC->>Br: signal_order_update.emit(msg)
    Br->>Sh: generate_callback_seq() (itertools.count)
    Br->>Q: put({type: OrderUpdate, data, seq_no, seq_kind: callback})

    Note over SJ: 成交回報另一條路徑
    SJ->>SJC: on_trade(trade_data)
    SJC->>Br: signal_trade_update.emit(trade_data)
    Br->>Q: put({type: TradeUpdate, data})
    Br->>PB: pb.on_fill_event(trade_data)
    PB->>PB: _invalidate_event.set()<br/>_tick_event.set()
    Br->>PB: run_coroutine_threadsafe(<br/>subscribe_position_contracts())
    Note over PB: fire-and-forget +<br/>add_done_callback 記 log

    SJ->>EB: event_bus.on_fill (由 OM 觸發)
    EB-->>RM: RiskManager._on_fill<br/>→ _order_timestamps.append(now)
    EB-->>OM: 更新本地訂單簿

    QB->>Q: get() (持續消費)
    QB->>FE: send_text({OrderUpdate})
    FE->>FE: TradingContext 用 seq_no 排序更新
```

---

## 8. Watchdog + 自動重連

```mermaid
flowchart TD
    Timer[threading.Timer 5s] --> Check[check_connection]
    Check --> CkAPI{api.list_accounts<br/>成功?}
    CkAPI -->|fail| MarkDown[_is_connected = False]
    CkAPI -->|ok| CkWatch{now - last_message_time<br/>> 15s?}
    CkWatch -->|yes 靜默斷線| MarkDown
    CkWatch -->|no| Reschedule
    MarkDown --> Try[_attempt_reconnect]
    Try --> Sleep5[等 5s]
    Sleep5 --> Re[_do_login_reconnect]
    Re -->|success| Resub{current_contract?}
    Re -->|fail| Sleep10[等 10s → 再試]
    Sleep10 --> Re
    Resub -->|有| Sub[subscribe 原合約]
    Resub -->|無| Reschedule
    Sub --> Reschedule[排下次 5s Timer]
    Reschedule --> Timer

    style MarkDown fill:#ef9a9a
    style Sub fill:#a5d6a7
```

每次 Shioaji callback 都會更新 `last_message_time`；只要 15 秒內沒收任何 tick，watchdog 就視為靜默斷線並觸發重連。

---

## 9. 每日 04:00 風控重置

```mermaid
sequenceDiagram
    autonumber
    participant DL as _daily_risk_reset task
    participant RM as RiskManager

    loop forever
        DL->>DL: now = datetime.now(Asia/Taipei)
        DL->>DL: target = next 04:00
        DL->>DL: await asyncio.sleep((target - now).seconds)
        DL->>RM: reset_daily()
        RM->>RM: with _lock:<br/>_daily_realized_pnl = 0<br/>_daily_unrealized_pnl = 0<br/>_order_timestamps.clear()<br/>_recent_orders.clear()<br/>trading_enabled = True<br/>_breach_emitted = False
        Note over DL: log 完成後 loop
    end
```

---

## 10. 執行緒 / 事件迴圈邊界

```mermaid
graph LR
    subgraph BrokerThread["Shioaji Broker Thread (同步)"]
        CB1[on_tick_fop / on_tick_stk]
        CB2[on_bidask_*]
        CB3[on_order_status]
        CB4[on_trade]
        Timer[threading.Timer 5s watchdog]
    end

    subgraph EventLoop["FastAPI asyncio Event Loop (主執行緒)"]
        WS[/ws/quotes handler/]
        QB[quote_broadcaster]
        PB[pnl_broadcaster]
        DL[_daily_risk_reset]
        AL[_auto_login]
        ROrd[orders.* handler]
        RAcc[accounts.* handler]
    end

    subgraph ThreadPool["asyncio default ThreadPoolExecutor"]
        TP1[SJC.login]
        TP2[SJC.place_order]
        TP3[SJC.list_positions]
        TP4[SJC.cancel_all]
        TP5[api.update_status]
    end

    CB1 & CB2 & CB3 & CB4 -.call_soon_threadsafe.-> EventLoop
    ROrd -.asyncio.to_thread.-> TP2 & TP3
    RAcc -.asyncio.to_thread.-> TP1 & TP3 & TP5
    PB -.asyncio.to_thread.-> TP3

    style BrokerThread fill:#ffebee
    style EventLoop fill:#e8f5e9
    style ThreadPool fill:#fff3e0
```

**核心安全性原則：**

| 邊界 | 跨越方式 | 註解 |
|---|---|---|
| Broker thread → Event loop | `shared.fastapi_loop.call_soon_threadsafe(queue.put_nowait, item)` | bridge 唯一允許的路徑 |
| Event loop → Shioaji sync API | `await shared.run_in_qt_thread(fn, ...)` = `asyncio.to_thread` | 修補後不再阻塞 event loop |
| Broker thread / Event loop 共讀 RiskManager state | `with self._lock:` | 修補後加 RLock |
| 訂單序號跨 thread | `itertools.count` (CPython 原子) | 修補後 thread-safe |

---

## 11. 前端 ↔ 後端訊息類型

```mermaid
classDiagram
    class WSMessage {
        +string type
    }
    class Tick {
        +string Symbol
        +float Price, Open, High, Low
        +int Volume, TickType
        +string TickTime, Action
        +float Reference?, LimitUp?, LimitDown?
    }
    class BidAsk {
        +string Symbol
        +float[] AskPrice, BidPrice
        +int[] AskVolume, BidVolume
        +int[] DiffBidVol, DiffAskVol
        +string Time
    }
    class OrderUpdate {
        +dict data
        +int seq_no
        +string seq_kind = "callback"
    }
    class TradeUpdate {
        +dict data
    }
    class AccountUpdate {
        +dict data
    }
    class PnLUpdate {
        +position[] positions (含 pnl_stale)
        +float total_pnl, total_realized
        +bool any_stale
    }
    class SmartOrderUpdate {
        +dict data
    }

    WSMessage <|-- Tick
    WSMessage <|-- BidAsk
    WSMessage <|-- OrderUpdate
    WSMessage <|-- TradeUpdate
    WSMessage <|-- AccountUpdate
    WSMessage <|-- PnLUpdate
    WSMessage <|-- SmartOrderUpdate
```

---

## 12. 部署拓樸（docker-compose）

```mermaid
graph LR
    subgraph User["使用者 macOS / Win"]
        Browser[Chrome / Edge / Electron]
    end

    subgraph Docker["docker-compose 一鍵啟動"]
        subgraph FrontendC["frontend container"]
            Nginx[nginx:alpine<br/>:5173]
            Static[React 靜態檔]
        end
        subgraph BackendC["backend container"]
            UV[uvicorn<br/>:8000]
            APP[FastAPI app]
        end
    end

    subgraph Internet
        SJ[Shioaji 永豐金 API]
    end

    Browser <-->|http :5173| Nginx
    Nginx -->|reverse proxy /api| UV
    Nginx -->|reverse proxy /ws| UV
    UV --> APP
    APP <--> SJ

    style FrontendC fill:#e1f5fe
    style BackendC fill:#fff3e0
```

`docker-compose.yml` 跑兩個 container：

- **frontend**：nginx 靜態檔 + 反向代理 `/api`、`/ws` 到 backend
- **backend**：uvicorn + FastAPI，僅綁 container 內 8000 port，由 frontend 代理進來

CORS 設定（`main.py`）只允許 localhost；正式部署可透過 `LIGHTRADE_ALLOWED_ORIGINS` 環境變數擴充。
