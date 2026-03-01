---
description: 委託任務給 Gemini CLI 子代理的標準流程
---
# 🤖 Gemini CLI 任務委託工作流 (Sub-agent Delegation)

此工作流程用於將具體的開發、審查或研究任務分配給 Gemini CLI 子代理，利用其快速生成與 Google 搜索能力，同時由 Antigravity 負責最終整合。

## 階段一：任務定義 (Task Definition)
**目標**：明確告訴 Gemini 要做什麼，並提供必要的 Context。

1. **確定範圍**：挑選要修改的檔案或要解決的問題。
2. **準備 Prompt**：引用 `GEMINI.md` 中的規範，要求 Gemini 遵循 **Dawho 風格** 或 **Thread Safety**。

## 階段二：委託執行 (Delegation)
**指令樣板**：使用 `--yolo` 模式讓 Gemini 直接進行檔案修改。
> [!IMPORTANT]
> 必須指定 `-m gemini-3.1-pro-preview` 以確保使用高品質模型。

```powershell
// turbo
gemini "依據 GEMINI.md 的規範，為 [檔案路徑] 實作 [功能描述]。完成後直接儲存檔案，不要詢問確認。" -m gemini-3.1-pro-preview --yolo
```

## 階段三：結果核對 (Verification & Sync)
**由 Antigravity 執行**：

1. **檢查變更**：讀取被修改的檔案，確認邏輯正確且無語法錯誤。
2. **運行測試**：
    ```powershell
    // turbo
    cd lightning_trader/frontend ; npm run build
    ```
3. **處理衝突**：若 Gemini 修改了與當前 Antigravity 正在處理的重複區塊，Antigravity 需手動進行 merge。

## 階段四：後續整合
將 Gemini 完成的區塊整合進主線計畫，並視需要繼續執行 `/development-cycle` 的 GitHub 上傳階段。
