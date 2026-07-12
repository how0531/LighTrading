# 啟動對帳協議（WS3，保守安全版）

> 程式：`lightning_trader/backend/services/reconciliation.py`
> 掛鉤：`lightning_trader/backend/main.py` lifespan `_auto_login` → 登入成功且
> `subscribe_position_contracts()` 之後，`await reconcile_on_startup()` 一次。
> 測試：`lightning_trader/tests/test_reconciliation.py`

## 為什麼需要

部位 / 委託 / 智慧單狀態同時活在**三處**：

1. **券商**（權威來源）——`list_positions` / `list_trades`。
2. **我方 SQLite**——`smart_order_store`（智慧單）、`trade_journal`（成交）。
3. **前端**——畫面快取。

backend 崩潰重啟後，我方 SQLite 可能過時。目前開機是**盲信 SQLite re-arm**：
`SmartOrderEngine` 把 store 內仍 `active` 的智慧單直接掛回，不與券商校準。
若這段停機期間券商端狀態已變（掛單被外部撤 / 已成交 / 持倉不同），我方會帶著
過時狀態繼續跑——這正是「單一真相來源」要修的破口。

**啟動對帳**在開機時與券商校準一次，偵測落差、告警留痕，並把殭屍智慧單交回
既有引擎安全處理。

## 本次做什麼（範圍界線，誠實遵守）

只做**不依賴真 SDK 細節**的安全部分：

| 面向 | 對帳什麼 | 落差如何處理 |
|---|---|---|
| **持倉** | 券商 `list_positions_strict()` 的每檔持倉 vs 我方 `trade_journal` 近期成交推導的**淨口數**（Buy +、Sell −） | 對不上 → **告警**（`logger.critical` + `event_bus.on_risk_breach("block")` + `audit_log.record`）。**不自動修正**。 |
| **智慧單（殭屍）** | 我方 active 且有券商掛單編號的 CHASE（`broker_order_ids` 非空、`CHASING`）vs 券商活躍委託快照 | 券商查無對應活躍委託 → 標記殭屍 + 告警 + audit，並呼叫既有 `SmartOrderEngine.sync_broker_orders()` 讓引擎 re-attach / 標終態 |
| **委託快照** | 券商活躍委託數（供報告 / 稽核） | 僅記錄；即時委託同步仍由既有 `order_sync` 迴圈負責 |

### 持倉落差分類

- **`no_local_record`**：券商有倉，我方 journal 完全對不上該商品 → 最強落差
  （最可能是漏記的外部成交，或 journal 尚未涵蓋建倉成交）。
- **`qty_mismatch`**：商品有紀錄但淨口數對不上 → 落差（精確校正待 SDK 落差表）。

> 淨口數推導是**唯讀比對**，本質依賴 Deal 欄位語意（累計 vs 單筆、序號穩定性），
> 因此**只用於偵測 → 告警**，不驅動任何自動修正。

### 殭屍智慧單怎麼接既有引擎

只有 **CHASE**（與 Bracket 進場）會在券商端留活躍掛單；MIT / OCO / TrailingStop
是**本地條件單**，券商端本來就沒有對應掛單——「券商查無」對它們**不算**殭屍，
不會誤報。

對 active 且 `CHASING`、`broker_order_ids` 非空的 CHASE：

1. 比對其編號（id/seqno/ordno 任一）是否落在券商**活躍**委託快照
   （`build_broker_order_index` 過濾 `ACTIVE_STATUSES`）中。
2. 對得上 → `matched`（不誤判）。
3. 對不上且**快照完整** → 標記殭屍、告警 + audit。
4. 無論如何，呼叫 `SmartOrderEngine.sync_broker_orders(index, snapshot_complete)`——
   **沿用既有能力**（re-attach 對得上的、連續數輪對不上的標
   `CANCELLED_EXTERNAL` 終態），對帳器不重造輪子、不改 engine。
   最終終態的收斂由持續運轉的 `order_sync` 迴圈（每 2.5s 呼叫同一 hook）完成。

> **快照不完整**（任一帳號 `update_status` 失敗）時**不判殭屍**——缺席不可信，
> 避免把「查詢失敗」誤殺成「外部撤單」。`snapshot_complete=False` 同時傳給引擎，
> 沿用其既有的 P1-4a 保護。

## `LIGHTRADE_RECON_HALT_ON_DIVERGENCE` 語意

偵測到「無法安全判定」的落差時的處置旗標，**比照 WS1 的安全預設**：

| 值 | 行為 |
|---|---|
| **未設 / `false`（預設）** | **只告警不停**——記 critical log、發 `on_risk_breach`、寫 audit，但**不改變交易行為**。 |
| `true` / `1` / `yes` / `on` | **fail-safe 停用交易**——把 `RiskManager.config.trading_enabled` 設 `False`，要求人工確認後再啟用；並記 `recon_halt` audit。（reduce-only 出場仍由 RiskManager 既有邏輯放行。） |

預設 `False` 的理由：對帳的持倉淨口數推導本質依賴尚未驗證的 SDK 欄位語意
（見下），誤報可能。安全預設應是「留痕告警、不擅自癱瘓交易」，把停用留給
明確開啟旗標的營運者。

## Best-effort：絕不擋啟動

`reconcile_on_startup()` 全程包在 try/except 中：券商快照走 `sync_executor`
（阻塞 I/O 不佔用下單佇列、不卡 event loop），任何一步例外都被吞掉、只記 log，
回傳報告 dict 而非拋出。未登入券商則整段跳過。

## audit 事件型別

寫入 `audit_log`（`LIGHTRADE_AUDIT_DB`）：

- `recon_start` / `recon_summary`——對帳起訖與統計。
- `recon_position_divergence`——持倉落差（meta 帶 broker_net / local_net / reason）。
- `recon_zombie_smart_order`——殭屍智慧單（meta 帶 broker_order_ids / chase_status）。
- `recon_halt`——因落差 fail-safe 停用交易（僅 HALT 旗標開啟時）。

## 哪些積極修正**待 SDK 落差表**（`docs/SDK_GAP_TABLE.md`）

本次**刻意不做**、待真 shioaji + 模擬帳戶跑 `scripts/sdk_smoke.py` 填完落差表後
才設計的積極修正：

1. **journal 補記漏接成交 / 已實現損益重算**——依賴 Deal 是否帶穩定唯一序號
   （`seq`/`exchange_seq`，落差表 B1）與 `deal_quantity` 是否為累計 int（B2）。
   序號不穩或語意不符 → `INSERT OR IGNORE` 去重失效 → 已實現損益翻倍。**必須先
   驗證再動 journal。**
2. **持倉淨口數的權威校正**——目前只「偵測落差 → 告警」。要據券商持倉**回寫/
   重建**我方帳，需先確認 `list_positions` 的 `direction` / `quantity` / `price`
   欄位語意與多帳號彙總行為。
3. **委託 `ordno` 為空時的 re-attach 退路**——落差表 A1：若下單當下 `ordno` 為空、
   成交回報才補，殭屍/去重比對鍵在成交前不穩，須確認退路（seqno? id?）。

在這些欄位語意由 `SDK_GAP_TABLE.md` 落地為明確結論前，對帳維持
**偵測 + 告警 + 交回既有引擎**的保守姿態，不做任何以「我方推導」覆寫券商或
改寫 journal 的動作。
