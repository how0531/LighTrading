---
description: 完整的開發工作流程 (規劃 -> 實作 -> 檢驗 -> GitHub)
---
# 🚀 LighTrade 完整開發工作流程

這個工作流程定義了從功能規劃到程式碼上傳 GitHub 的標準生命週期。主要由 Antigravity 負責架構分析與整合，並可利用 Gemini CLI 進行快速且平行的程式碼生成。

## 階段一：規劃與設計 (Planning)
**主要負責**：Antigravity & User

1. **需求分析**：User 提出具體功能需求（例如新增某個 UI 面板、增加一個 API 路由等）。
2. **架構規劃**：Antigravity 分析當前專案結構與文件，制定修改計畫。
   * 會考慮到專案的核心規範，例如：**前端 Dawho 風格** 與 **後端 Thread Safety**。
3. **計畫確認**：Antigravity 產出 `implementation_plan.md` 讓 User 審核。待 User 確認無誤後，進入開發階段。

## 階段二：工程與實作 (Execution)
**主要負責**：Gemini CLI (代理子代理) / Antigravity / User 手動

User 可依據需求規模與偏好，決定由誰來執行開發：

*   **選項 A：委託 Gemini 執行 (適合大量生成或獨立區塊)**
    透過調用 Gemini CLI 代理進行實作（因帶有 `--yolo` 參數會直接覆寫檔案，確保指令明確）。
    ```powershell
    // turbo
    gemini "依據我們剛剛討論的規劃，實作 [功能名稱]。請確保符合 LighTrade 的風格與 Thread Safety 規範。" --yolo
    ```
*   **選項 B：由 Antigravity 執行 (適合精細的局部修改)**
    User 直接指示 Antigravity 使用 `replace_file_content` 或 `write_to_file` 工具去更改檔案。
*   **選項 C：User 自行實作**
    User 於開發環境中手動編寫程式。

## 階段三：檢驗與測試 (Verification)
**主要負責**：Antigravity & User

實作完成後，必須進行正確性驗證：

1. **檢查是否有語法或編譯錯誤**（尤其是 TypeScript 前端）：
    ```powershell
    // turbo
    cd lightning_trader/frontend ; npm run build
    ```
2. **前後端整合測試**：
    * User 於瀏覽器進行操作。
    * 或指示 Antigravity 讀取 Terminal log，檢查是否有 `QObject::startTimer` 等崩潰錯誤。
3. **紀錄與修復**：遇到 bug 則回到「階段二」修復，最終產出 `walkthrough.md` 紀錄本次完成的任務。

## 階段四：上傳至 GitHub (Deployment & Version Control)
**主要負責**：Antigravity 代為執行指令

1. **加入階段 (Stage changes)**
    ```powershell
    // turbo
    git add .
    ```
2. **提交變更 (Commit)**
    請根據本次完成的任務，修改以下指令的 commit message 以保持良好的開發日誌紀錄。
    ```powershell
    // turbo
    git commit -m "feat/fix: [輸入對應的更新內容]"
    ```
3. **推送到遠端儲存庫 (Push)**
    將變更推向遠端 GitHub 專案。
    ```powershell
    // turbo
    git push origin main
    ```
