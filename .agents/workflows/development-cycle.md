---
description: 完整的開發工作流程 (規劃 -> 實作 -> 檢驗 -> GitHub)
---

# 🚀 LighTrade Agent 團隊開發流程 v2

> **設計原則**：減少 token 消耗、避免重複讀檔、用檔案傳遞而非 prompt 傳遞。

---

## 🏗️ 角色定義

| 角色                   | 負責                         | 何時登場 |
| ---------------------- | ---------------------------- | -------- |
| **Orchestrator (你)**  | 拆解需求、分配任務、整合決策 | 全程     |
| **Agent A-D** (開發者) | 撰寫程式碼                   | Phase 2  |
| **Agent E** (品管)     | 審查、效能分析               | Phase 3  |

---

## Phase 1：規劃（1 個 Prompt）

### 1-1. 需求 → 任務拆解

User 提出需求後，Orchestrator 產出 **一份** `tasks/PLAN.md`，內含：

```markdown
# V1.X.X — [功能名稱]

## 任務拆解

- [ ] Task 1: [描述] → 修改 [檔案名]
- [ ] Task 2: ...

## 檔案影響矩陣

| 檔案               | Agent | 修改類型          |
| ------------------ | ----- | ----------------- |
| TradingContext.tsx | A     | 新增 state/method |
| Panel_Foo.tsx      | C     | 新建              |

## 依賴圖

Task 1 → Task 3（依賴 Task 1 的介面）
Task 2（獨立）

## 公共介面契約

（跨 Agent 共用的 interface / type，寫在此統一定義）
```

> 💰 **省 token**：不再為每個 Agent 寫獨立任務檔。用一份 PLAN.md 搞定，Agent 只需讀自己的段落。

### 1-2. User 確認

User 審核 `tasks/PLAN.md`。通過後進入 Phase 2。

---

## Phase 2：開發（Orchestrator 逐任務執行）

### 執行策略：**Sequential + Batch**

```
❌ 舊流程：每個 Agent 獨立 prompt（4 次完整 context = 4x token）
✅ 新流程：Orchestrator 自己按順序執行（1 次 context，逐任務修改）
```

**流程**：

1. **讀一次相關檔案**（一次性載入所有需要的檔案）
2. **按依賴順序逐任務實作**：
   - 先做無依賴的任務
   - 再做有依賴的任務
3. **每完成一個任務立即做 micro-check**：
   - `npx tsc --noEmit`（TypeScript 編譯）
   - 有錯立即修，不累積
4. **完成後在 `tasks/PLAN.md` 打勾** `[x]`

> 💰 **省 token**：不用為每個 Agent 重新載入 GEMINI.md + 專案架構，一次讀取全程複用。

### Micro-Check 範本

```bash
// turbo
cd lightning_trader/frontend && npx tsc --noEmit
```

每完成一個任務後立即執行，有錯當場修，0 累積 debt。

---

## Phase 3：品管審查（1 次通過）

### 3-1. 自動化檢查（先跑工具，再看結果）

```bash
// turbo
cd lightning_trader/frontend && npx tsc --noEmit
```

### 3-2. 品管審查清單（以 GEMINI.md 為基準，逐項掃描）

只看 **diff**，不重讀全檔：

```bash
// turbo
git diff --stat
```

然後針對 diff 逐條檢查：

| 審查項             | 怎麼查                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- |
| `run_in_qt_thread` | `grep -r "shioaji_client\." backend/main.py` 看有無遺漏                                |
| React hooks deps   | 看 `useEffect` / `useMemo` / `useCallback` 的 `[]`                                     |
| `any` 型別濫用     | `grep -rn ": any"`                                                                     |
| cleanup 遺漏       | 每個 `setInterval` / `addEventListener` 是否有 `clearInterval` / `removeEventListener` |
| PnL 除以零         | 檢查 `pos.qty` 或 `margin_required` 為 0 的分支                                        |

> 💰 **省 token**：用 `git diff` + `grep` 取代全檔 `view_file`。

### 3-3. 修補

發現問題 → 直接修 → 再跑一次 tsc → 通過。

---

## Phase 4：上傳 GitHub

```bash
// turbo
git add .
```

```bash
// turbo
git commit -m "feat: V1.X.X — [功能摘要]"
```

```bash
// turbo
git push origin main
```

---

## 📊 新舊流程 Token 消耗對比

| 步驟         | 舊流程                             | 新流程               |
| ------------ | ---------------------------------- | -------------------- |
| 規劃         | 1 總覽 + 4 Agent 任務檔            | 1 份 PLAN.md         |
| 開發         | 4 個 Agent 各自讀 GEMINI.md + 專案 | Orchestrator 讀 1 次 |
| 讀檔         | 每個 Agent 重複讀相同依賴檔        | 一次性載入所有檔案   |
| 品管         | 全檔重讀                           | `git diff` + `grep`  |
| **預估節省** | —                                  | **~60-70% token**    |

---

## ⚡ 效率提升秘訣

1. **批次讀檔**：開工前一次性載入所有要改的檔案（平行 `view_file`）
2. **Micro-Check**：每改一個檔案就跑 `tsc`，不要累積到最後才發現爆一堆錯
3. **Interface-First**：先定義公共介面（`types.ts` / Context），再實作各元件
4. **grep 取代 view_file**：品管時只看 diff，不重讀完整檔案
5. **一份 PLAN.md**：不為每個 Agent 寫獨立冗長任務檔
