# 真 Shioaji SDK 落差驗證表（模擬環境）

> **目的**：本專案「所有後端測試」都對 `lightning_trader/tests/fake_shioaji.py`（假 SDK 替身）驗證。
> 假 SDK 是我方對真 Shioaji 行為的**假設**——過去已兩次因假設與真實不符造成資金 bug
> （去重失效 → 已實現損益翻倍；撤單非同步 → 超額建倉）。
>
> 本表把「我方假設」逐項攤開，供在**真 shioaji + 模擬帳戶**跑 `scripts/sdk_smoke.py` 後，
> 用其 dump 輸出填「真實行為」欄，判定落差。
>
> **這張表同時服務兩條路線**：
> 1. **整併路線**（官方 shioaji server 掛載）——與 `docs/integration/CAPABILITY-GAP-TEMPLATE.md`
>    互補：那張表問「官方 server 有無此能力」，本表問「真 SDK 實際回什麼欄位」。
> 2. **WS3 啟動對帳協議**——啟動時 `list_trades` 快照 → 重建活躍委託 / 補記漏接成交，
>    其正確性完全依賴下列「委託/成交欄位語意」的真實結論。

## 怎麼跑

```bash
# 前置：專案根目錄有 .env 且 SIMULATION=true、填好模擬帳戶 API_KEY / SECRET_KEY，
#       且已安裝真 shioaji（pip show shioaji）。
python3 scripts/sdk_smoke.py > docs/smoke_out.txt 2>&1   # 或直接看終端
```

腳本硬檢查 `SIMULATION=true`（非 true 拒跑）、掛遠價避免成交、跑完自動撤單。
詳見 `scripts/sdk_smoke.py` 頂部大註解。

---

## 欄位說明

- **檢查項**：要對照的 SDK 行為點。
- **我方假設（現況碼）**：目前程式碼 / fake SDK 怎麼假設的（附出處檔案）。
- **真實行為（待填）**：跑 `sdk_smoke.py` 後，依 dump 輸出填實測結果。
- **落差**：真實 vs 假設是否一致 / 哪裡不同。
- **影響的資金邏輯**：落差若成立，威脅哪條資金正確性不變量。
- **待辦**：據落差要改 fake / 改碼 / 加 adapter / 標 blocker。

---

## 落差表

### A. 下單 place_order

| 檢查項 | 我方假設（現況碼） | 真實行為（待填） | 落差 | 影響的資金邏輯 | 待辦 |
|---|---|---|---|---|---|
| **A1. place_order 回傳當下 `order.ordno` 是否已有值** | fake `place_order` 預設當下即給 `ordno=ORD0001`（`deferred_ordno=False`）；真 SDK 選項 `deferred_ordno=True` 已模擬「下單當下 ordno 為空、成交回報才補」。現況碼在 callback (`on_order_status`) 以 `msg.get('ordno')` 取號、CHASE 以 `trade.order.ordno` re-attach。出處：`fake_shioaji.py:246-247`、`shioaji_client.py:385-388`、`order_sync.py:87-97` | _（待填：STEP 1「下單當下關鍵欄位快照」的 `order.ordno`）_ | _（待填：當下為空 or 已有）_ | 若下單當下 ordno 為空 → CHASE 以 ordno re-attach 掛單、fill 去重鍵 `ordno#seq` 都可能在成交回報前拿到空號 → 錯配 / 去重鍵不穩 | 若確為空：確認碼各處在「ordno 為空」時的退路（seqno? id?）；並把 fake 預設改成 `deferred_ordno=True` 讓測試反映真實 |
| **A2. `order.seqno` / `order.id` 的值與角色** | fake：`id=ORD000N`、`seqno=NNNNNN`（純序）、`ordno`=交易所單號。現況碼把 `id/seqno/ordno` 三者都當「候選比對鍵」（`cancel_order_by_ids`、`build_broker_order_index`），但**去重時嚴禁用 seqno 當成交序號**。出處：`shioaji_client.py:1069`、`trade_journal.py:69`（docstring 警告） | _（待填：STEP 1 三個欄位實際值/型別）_ | _（待填）_ | 誤把 seqno（委託序號）當去重序號 → 同單多筆部分成交撞成一筆 → 已實現漏計 | 確認 seqno vs ordno 語意；若真 SDK 欄位命名不同（如 `order_id`）需補 adapter |
| **A3. 下單當下 `status.status.name`** | fake 給 `"Submitted"`。現況碼活躍狀態集合 `{PendingSubmit, PreSubmitted, Submitted, PartFilled}`。出處：`order_sync.py:34`、`shioaji_client.py:1076` | _（待填：STEP 1 的 status.status）_ | _（待填：是否為 PendingSubmit 等更早態）_ | 狀態名不在活躍集合 → 委託快照漏顯示 / CHASE 對帳誤判外部撤單 | 補齊真實狀態機所有名稱到活躍集合 |

### B. 委託/成交查詢 update_status + list_trades

| 檢查項 | 我方假設（現況碼） | 真實行為（待填） | 落差 | 影響的資金邏輯 | 待辦 |
|---|---|---|---|---|---|
| **B1. Deal 物件是否帶穩定唯一序號（`exchange_seq` / `seq`）** | **fill 去重的第一優先鍵**。callback 路徑找 `exchange_seq`/`dealseq`/`seq`；order_sync 路徑找 Deal 物件的 `.seq` 再 `.exchange_seq`；缺序號才退回內容鍵 `ordno#price#qty#cum_qty`。fake Deal 給 `.seq`。出處：`trade_journal.py:54-88,185-192`、`order_sync.py:144-149`、`fake_shioaji.py:106-108` | _（待填：STEP 2「deal[j] 完整結構」——有無 seq / exchange_seq，欄位確切名稱）_ | _（待填：欄位是否存在、名稱是否為 seq / exchange_seq / 其他）_ | **候選 blocker**：若無穩定每筆唯一序號、或欄位名不同（我方沒讀到）→ `INSERT OR IGNORE` 去重失效 → 已實現損益 / 熔斷資料源**翻倍失真** | 對齊真實欄位名到 `authoritative_fill_id` 與 `extract_fill`/`extract_deal_fills`；fake 補上真實欄位名 |
| **B2. `status.deal_quantity` 是否存在、型別、是否為「累計」成交量** | 現況碼 `int(getattr(status, 'deal_quantity', getattr(status,'filled_quantity',0)))`，當**累計**已成量用（CHASE 剩量 = qty − deal_quantity）。fake 用 int、累計。出處：`shioaji_client.py:1150-1151`、`order_sync.py:62-64,96-97`、`fake_shioaji.py:303` | _（待填：STEP 2 每筆 deal_quantity 值/型別）_ | _（待填：int? str? 累計 or 單筆?）_ | **候選 blocker**：若非累計 / 為 str 未轉 → CHASE 剩量算錯 → **超額建倉**；或委託快照 filled 顯示錯 | 若型別/語意不同：加轉型與語意校正；fake 對齊 |
| **B3. Deal `.ts` 時間單位（秒/毫秒/奈秒）** | `_ts_to_ms` 依大小猜單位（>1e15 奈秒、>1e11 毫秒、否則秒）。出處：`order_sync.py:104-116`、`fake_shioaji.py:107`（ts=0） | _（待填：STEP 2 deal.ts 實際值/型別）_ | _（待填：實際單位）_ | ts 僅供顯示與內容防重時窗（非權威鍵），落差影響小但仍記 | 若單位固定：可簡化 `_ts_to_ms`；fake 給貼近真實的 ts |
| **B4. 本 session 下的單是否出現在 `list_trades()`** | 現況假設「會」（CHASE / order_sync 對帳全靠 list_trades 找委託）。fake 的 place_order 會把 trade 加進 `self.trades`。出處：`fake_shioaji.py:261`、`order_sync.py` 全域 | _（待填：STEP 2 list_trades 是否含 STEP 1 那筆）_ | _（待填）_ | 若本 session 單不在 list_trades → 對帳/re-attach 找不到單 | 若不在：需另存本地委託表；標整併/WS3 設計前提 |
| **B5. `list_trades` 是否含「其他 session / 券商 App」外部委託與成交** | 現況 order_sync 迴圈**假設會**（先 update_status 逐帳號再 list_trades），才能把外部成交補進 journal 餵熔斷。出處：`order_sync.py:181-236` | _（待填：需另開一個 session / 券商 App 下單觀察，本腳本單 session 不易測；先記待驗）_ | _（待填）_ | 若不含外部成交 → 外部管道已實現損益漏算 → 熔斷被繞過 | 與 CAPABILITY-GAP-TEMPLATE.md 第②列合併結論；決定 order_sync 去留 |

### C. 改單 update_order

| 檢查項 | 我方假設（現況碼） | 真實行為（待填） | 落差 | 影響的資金邏輯 | 待辦 |
|---|---|---|---|---|---|
| **C1. 改價 `api.update_order(trade=trade, price=new)` 的回傳與是否同步反映** | 現況碼呼叫後回傳被忽略、直接視為成功；價量同改時「先改價 sleep 0.2s 再改量」。出處：`shioaji_client.py:1005-1049` | _（待填：STEP 3 update_order 回傳結構 + 改價後 order.price 是否已反映）_ | _（待填：回傳含什麼？改價是否即時反映或需 update_status？）_ | 回傳若帶成功/失敗旗標而被忽略 → 改單失敗被當成功；未同步反映 → 後續以舊價比對誤判 | 若回傳帶狀態：改為檢查回傳；確認 0.2s sleep 是否足夠 |
| **C2. 減量 `api.update_order(trade=trade, qty=new)` 語意（新量=絕對剩量 or 減去量）** | 現況碼 `qty` 當**目標新量**傳入（`qty != trade.order.quantity` 才改）。出處：`shioaji_client.py:1025,1031,1037` | _（待填：需搭配文件 / 實測，本腳本 STEP 3 只改價；可自行擴充改量）_ | _（待填）_ | 若語意為「減去的量」而非「目標量」→ 減錯量 → 委託口數錯 | 確認語意；必要時修正呼叫與 fake |

### D. 撤單 cancel_order

| 檢查項 | 我方假設（現況碼） | 真實行為（待填） | 落差 | 影響的資金邏輯 | 待辦 |
|---|---|---|---|---|---|
| **D1. cancel_order 是否『同步生效』（撤後立即 list_trades 即見終態）** | 兩種假設並存：`cancel_all` / `cancel_orders_by_action_price` / `cancel_order_by_ids` **fire-and-forget**（送出即當作已撤，隱含同步）；CHASE `confirm_order_cancelled` 則**假設非同步**、輪詢 update_status 收斂。fake 預設同步（`async_cancel=False`），另有 `async_cancel=True` 模擬非同步。出處：`shioaji_client.py:1077,1090-1159`、`fake_shioaji.py:270-297` | _（待填：STEP 4「撤單後 立即查」vs「update_status 後」的 status 對照）_ | _（待填：立即是否已 Cancelled，還是需 update_status）_ | **候選 blocker**：若非同步而 fire-and-forget 路徑當同步 → 撤單在途舊單於交易所端成交 → CHASE 以為已撤而重掛 → **超額建倉**（正是歷史 bug） | 若非同步：把 fire-and-forget 路徑導向 confirm 語意；fake 預設應改 `async_cancel=True` 讓測試反映真實 |
| **D2. 撤單在途舊單是否可能先部分/全部成交（cancel-race）** | 現況 `confirm_order_cancelled` 明確為此設計：先確認終態再以**實際 filled_qty** 掛新單；fake 以 `cancel_race_hook` 模擬。出處：`shioaji_client.py:1090-1159`、`fake_shioaji.py:278-283` | _（待填：模擬環境不易造 race；記為需正式盤前小口數校驗）_ | _（待填）_ | 超額建倉不變量核心 | 正式盤前用最小口數專項校驗 D1+D2 |
| **D3. cancel 已成交 / 已撤的單，回傳與狀態** | 現況假設對非活躍單撤單為 no-op（`cancel_order_by_ids` 先查狀態才撤）。出處：`shioaji_client.py:1074-1083` | _（待填：STEP 4 對已撤單再撤的回傳 / 例外）_ | _（待填）_ | 誤撤已成單無害但例外處理需穩健 | 依實測補例外處理 |

### E. 持倉 / 帳務 list_positions + account_balance

| 檢查項 | 我方假設（現況碼） | 真實行為（待填） | 落差 | 影響的資金邏輯 | 待辦 |
|---|---|---|---|---|---|
| **E1. Position 欄位名與型別（`code / quantity / direction / price / pnl`）** | 現況碼直讀 `p.quantity`（int）、`p.code`、`p.direction == Action.Buy`、`p.price`、`p.pnl`。出處：`shioaji_client.py:504-515`、`fake_shioaji.py:91-97` | _（待填：STEP 5 pos[k] 各欄位值/型別）_ | _（待填：欄位名 / direction 是否為 Action enum / quantity 型別）_ | 欄位名或 direction 型別不符 → 持倉方向/口數解析錯 → PnL、平倉/反手方向錯 | 對齊欄位；`direction` 若非 enum 需改比對 |
| **E2. 帳號 `account_type` / `category`（過濾 H 海外期貨）** | 現況碼以 `account_type` 或 `category`，`{'H'}` 視為不支援 list_positions。出處：`shioaji_client.py:486,496-498`、`fake_shioaji.py:77,83`（'S'/'F'） | _（待填：STEP 0 list_accounts 各帳號 account_type/category）_ | _（待填：實際欄位名與值）_ | 過濾錯 → 對不支援帳號查倉丟例外 → strict 查倉誤判失敗 → 錯誤跳過退訂 | 對齊帳號型別欄位與值域 |
| **E3. `account_balance` 回傳欄位** | 現況碼原樣回傳、未解析特定欄。fake 給 `equity/margin_available/margin_required/pnl`。出處：`shioaji_client.py:934-943`、`fake_shioaji.py:345-347` | _（待填：STEP 5 account_balance 結構）_ | _（待填：實際欄位名）_ | 目前無資金邏輯依賴具體欄位（僅顯示）；若未來風控用到需先對齊 | 記錄真實欄位供未來風控/保證金檢查用 |

### F. Callback 回報 dict（set_order_callback）

| 檢查項 | 我方假設（現況碼） | 真實行為（待填） | 落差 | 影響的資金邏輯 | 待辦 |
|---|---|---|---|---|---|
| **F1. order callback `(state, msg)` 的 `msg` dict 結構與 `state` 值** | 現況 `on_order_status(state, msg: dict)`：以 `str(state).lower()` 含 `'deal'` 判成交；`msg.get('ordno'/'seqno'/'price'/'quantity')`，deal 序號讀 `exchange_seq`/`dealseq`/`seq`，累計量讀 `cum_quantity`/`cum_qty`/`total_quantity`。出處：`shioaji_client.py:380-401`、`trade_journal.py:136-204`、`bridge.py:123-189` | _（待填：真實 callback 需**實際觸發成交**才觀察得到；本腳本掛遠價刻意不成交，故此列需另以「會成交的小單」在正式/模擬盤中專項觀察，或查 SDK tutor 文件）_ | _（待填：state 實際值、msg 是扁平 dict 還是含 nested order/deal）_ | **候選 blocker**：callback 是成交入 journal 的主路徑；若 msg 欄位名 / state 值與假設不符 → 成交漏記或去重鍵不同 → 已實現失真 | 需一次「會成交」的觀察（與 D2 一起做）；務必比對 msg 內 deal 序號欄位名是否等同 B1 的 Deal.seq |

---

## 驗收與判準

- **驗收**：A、B、D、E 各列「真實行為」欄填畢；B1 / B2 / D1 / F1 四個 **候選 blocker** 有明確結論。
- **候選 blocker（威脅資金不變量，須先收斂）**：
  - **B1**（Deal 唯一序號欄位）與 **F1**（callback msg deal 序號欄位）——去重鍵地基。
  - **B2**（deal_quantity 累計/型別）與 **D1**（撤單同步性）——CHASE「活躍量 + 已成量 ≤ qty」不變量地基。
- 任一候選 blocker 確認與假設不符 → 先修 `fake_shioaji.py` 讓測試反映真實、再修對應資金邏輯，並在正式盤前用最小口數複驗。
- 本腳本掛遠價、單 session，**測不到**：真實成交 callback（F1）、外部管道委託（B5）、cancel-race（D2）——這三項標為「需成交/多 session/正式盤前」專項校驗，勿因本腳本沒觸發就當「無落差」。
