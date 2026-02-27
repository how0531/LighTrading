$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$instructionPath = "C:\Users\How\OneDrive\Documents\LighTrade\lightning_trader\gemini_instructions.txt"

Write-Host "================================================" -ForegroundColor Cyan
Write-Host " 啟動 Gemini CLI 子代理 (閃電下單器 Phase 2) " -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

# 讓程式變成「常駐守護進程 (Daemon)」，確保任務可以一直進行
while ($true) {
    try {
        $prompt = Get-Content -Raw -Path $instructionPath
        
        Write-Host "`n[Auto-Run] 開始執行本輪任務檢查..." -ForegroundColor Magenta
        gemini --yolo -m gemini-3.1-pro-preview -p $prompt
        
        Write-Host "`n[Finish] 本輪執行完畢。" -ForegroundColor Green
    }
    catch {
        Write-Host "`n[Error] 執行過程遭遇錯誤: $_" -ForegroundColor Red
    }

    Write-Host "`n[Wait] 進入休眠，15秒後將自動甦醒並接續下一輪開發..." -ForegroundColor Yellow
    Write-Host " (若任務已全數完成，請手動關閉此視窗)" -ForegroundColor DarkGray
    Start-Sleep -Seconds 15
}
