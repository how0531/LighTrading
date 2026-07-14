# 官方 shioaji server 能力落差表（範本，未填）

> **這是範本，尚未填寫。** 待使用者依 `PLAN.md` 里程碑 0 執行後填入：啟動官方 shioaji server → 開 `/docs`（OpenAPI）→ 配合 Shioaji tutor 的 order/deal event 文件逐項核對。
>
> **全程只碰官方 server 工具，零 AGPL 曝險**（不讀 shioaji-pro-app 前端原始碼）。
>
> 目的：確認掛載式方向下「行情走官方 SSE、下單/委託/持倉/風控收斂自建後端」時，官方 server 的回報能力是否足以支撐自建後端的既有不變量。

---

## 填寫說明

- **檢查項**：要確認的官方 server 能力。
- **官方文件出處**：`/docs` 的端點/schema 欄位名，或 tutor 文件章節。填實際路徑，勿憑記憶。
- **我方現況對應**：這項能力在自建後端對應的機制/檔案/欄位。
- **落差**：官方有/無/部分；欄位名或語意是否對得上。
- **風險**：落差若成立，對哪個不變量造成什麼後果；是否為 blocker。

---

## 能力落差表

| 檢查項 | 官方文件出處 | 我方現況對應 | 落差 | 風險 |
|---|---|---|---|---|
| **① deal event 是否有穩定唯一序號** | _（待填：/docs deal event schema，找 exchange_seq 或等價欄位）_ | journal 去重鍵 `id = ordno#exchange_seq`（`trade_journal.py`，`INSERT OR IGNORE` 去重） | _（待填：官方是否提供穩定每筆成交唯一序號、欄位名為何）_ | 若無穩定唯一序號 → `INSERT OR IGNORE` 去重失效 → 已實現損益/熔斷資料源**翻倍失真**。**候選 blocker。** |
| **② 是否推「所有 session」的委託/成交** | _（待填：SSE 串流 scope 說明；是否只推本 session）_ | 自建 `order_sync` 2.5s 對帳迴圈，把「券商 App / 其他 session」的委託與成交拉回入帳，餵熔斷與 CHASE 對帳 | _（待填：官方 SSE 是否涵蓋外部管道，或僅本連線下的單）_ | 若僅推本 session → order_sync 對帳迴圈**不能簡化**、仍須保留；若推全 session → 可簡化對帳。決定 order_sync 去留。 |
| **③ 撤單是否有同步終態確認 + filled_qty** | _（待填：cancel 端點回應 schema；是否回終態與實際成交量）_ | CHASE cancel-replace 靠 `confirm_order_cancelled` 輪詢撤單終態 + 回填 filled_qty，維持不變量「活躍掛單量 + 已成量 ≤ qty」 | _（待填：官方撤單是否同步確認終態、是否回 filled_qty）_ | 若無同步終態確認 + filled_qty → CHASE 不變量無法維持 → **超額建倉**。**候選 blocker。** |
| **④ CA activate** | _（待填：CA 憑證啟用端點/流程）_ | LIVE 下 `activate_ca`；登入/CA/帳號生命週期為 SDK 語意 | _（待填：官方 server 是否代管 CA activate，流程是否對等）_ | 若不對等 → LIVE 下單無法啟用憑證，整條下單路徑不通。 |
| **⑤ stock / futopt 帳號選擇** | _（待填：下單 payload 帳號欄位、set_active_account 對應）_ | `place_order` 依 security_type 選 `active_stock_account` / `active_futopt_account`；`is_stock = len==4 && isdigit` | _（待填：官方 server 如何指定/切換股票與期權帳號）_ | 若帳號選擇語意不同 → 下錯帳號或下單被拒。 |
| **⑥ 零股 IntradayOdd** | _（待填：order_lot / IntradayOdd 支援）_ | order_lot 映射（含零股）| _（待填：官方是否支援盤中零股 order_lot）_ | 若不支援 → 零股下單功能缺口。 |
| **⑦ MKP（市價）** | _（待填：price_type 支援清單，是否含 MKP）_ | price_type 映射 LMT / MKT / **MKP** | _（待填：官方 price_type 是否含 MKP 或等價）_ | 若無 MKP → 對應下單型別缺口。 |
| **⑧ 漲跌停 / TotalVolume 對等性** | _（待填：tick / snapshot 欄位，是否含漲跌停價與 TotalVolume）_ | 前端 tick 含 canonical Symbol、TotalVolume；漲跌停/TotalVolume snapshot 補齊 | _（待填：官方 SSE tick 是否提供 TotalVolume、漲跌停價）_ | 若欄位缺 → 需 adapter 補齊或前端顯示/風控判斷缺資料。 |

---

## 驗收與回退判準

- **驗收**：本表填畢，三個關鍵列（①②③）有明確結論。
- **候選 blocker**：若 ①（無穩定唯一序號）或 ③（無同步撤單終態 + filled_qty）確認為「官方無此能力且無法以 adapter 補齊」，需在此停下重新評估——這兩者直接威脅去重與 CHASE 不變量。
- 其餘列（④–⑧）落差多可用 adapter 補齊或標記為功能缺口，逐項記錄即可。
