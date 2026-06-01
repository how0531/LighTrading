# build.ps1 — LighTrade Electron 打包腳本
# 執行方式:
#   cd lightning_trader && ./build.ps1           → 完整打包 (Step 1~4)
#   ./build.ps1 -FastBackend                     → 只重打 backend 並熱覆蓋進 Electron bundle
#   ./build.ps1 -FastFrontend                    → 只重打 frontend 並熱覆蓋進 Electron bundle
#   ./build.ps1 -SkipBackend                     → 跳過 backend 打包

param(
    [switch]$FastBackend,
    [switch]$FastFrontend,
    [switch]$SkipBackend
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$DIST_BACKEND  = Join-Path $ROOT "..\..\dist-backend"
$DIST_ELECTRON = Join-Path $ROOT "..\..\LighTrade\dist-electron\win-unpacked"
$UNPACKED_BACKEND  = Join-Path $DIST_ELECTRON "resources\backend"
$UNPACKED_FRONTEND = Join-Path $DIST_ELECTRON "resources\frontend\dist"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  LighTrade Build Script" -ForegroundColor Cyan
if ($FastBackend)  { Write-Host "  [Mode] FastBackend" -ForegroundColor Yellow }
if ($FastFrontend) { Write-Host "  [Mode] FastFrontend" -ForegroundColor Yellow }
Write-Host "======================================" -ForegroundColor Cyan

# ── 通用：殺掉 running 的 exe（避免 Copy-Item 鎖檔） ────────────────────────
function Stop-RunningLighTrade {
    Get-Process LighTrade,lightrade-backend -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host ("  stopping pid=" + $_.Id + " " + $_.ProcessName) -ForegroundColor Gray
        $_ | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 800
}

# ── Fast path: 只重打 backend ────────────────────────────────────────────────
if ($FastBackend) {
    Write-Host "`n[Fast] 重打 backend + 覆蓋 Electron bundle..." -ForegroundColor Yellow
    Stop-RunningLighTrade
    Set-Location $ROOT
    python -c "import nacl, nacl._sodium" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "pynacl 缺失" -ForegroundColor Red; exit 1 }
    pyinstaller backend.spec --clean --distpath $DIST_BACKEND --workpath "..\..\build-backend" --noconfirm
    if ($LASTEXITCODE -ne 0) { Write-Host "backend 打包失敗" -ForegroundColor Red; exit 1 }
    if (Test-Path $UNPACKED_BACKEND) {
        Copy-Item (Join-Path $DIST_BACKEND "lightrade-backend.exe") (Join-Path $UNPACKED_BACKEND "lightrade-backend.exe") -Force
        Write-Host "  已同步到 $UNPACKED_BACKEND" -ForegroundColor Green
    } else {
        Write-Host "  ⚠ $UNPACKED_BACKEND 不存在，請先跑完整 build 一次" -ForegroundColor Yellow
    }
    Write-Host "FastBackend 完成。" -ForegroundColor Green
    exit 0
}

# ── Fast path: 只重打 frontend ───────────────────────────────────────────────
if ($FastFrontend) {
    Write-Host "`n[Fast] 重打 frontend + 覆蓋 Electron bundle..." -ForegroundColor Yellow
    Stop-RunningLighTrade
    Set-Location "$ROOT\frontend"
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host "前端建置失敗" -ForegroundColor Red; exit 1 }
    if (Test-Path $UNPACKED_FRONTEND) {
        Remove-Item -Recurse -Force $UNPACKED_FRONTEND
        Copy-Item "$ROOT\frontend\dist" $UNPACKED_FRONTEND -Recurse -Force
        Write-Host "  已同步到 $UNPACKED_FRONTEND" -ForegroundColor Green
    } else {
        Write-Host "  ⚠ $UNPACKED_FRONTEND 不存在，請先跑完整 build 一次" -ForegroundColor Yellow
    }
    Write-Host "FastFrontend 完成。" -ForegroundColor Green
    exit 0
}

# ── Step 1: 建置 React 前端 ──────────────────────────────────────────────────
Write-Host "`n[1/4] 建置 React 前端..." -ForegroundColor Yellow
Set-Location "$ROOT\frontend"
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "前端建置失敗" -ForegroundColor Red; exit 1 }
Write-Host "前端建置完成 → frontend/dist/" -ForegroundColor Green

# ── Step 2: 打包 Python Backend ──────────────────────────────────────────────
if (-not $SkipBackend) {
    Write-Host "`n[2/4] 打包 Python Backend..." -ForegroundColor Yellow
    Set-Location $ROOT

    # Preflight：確保 venv 有 pynacl + _sodium.pyd + 其他 Cython 依賴
    $preflightMods = @('nacl._sodium', 'pyrsca', 'pysolace', 'requests', 'loguru', 'xxhash')
    foreach ($m in $preflightMods) {
        python -c "import $m" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Preflight 失敗: 套件 '$m' 在目前 Python 環境缺失" -ForegroundColor Red
            Write-Host "請執行: pip install shioaji pynacl pyrsca pysolace" -ForegroundColor Yellow
            exit 1
        }
    }
    Write-Host "  Preflight OK: 所有 shioaji Cython 依賴齊全" -ForegroundColor Gray

    Stop-RunningLighTrade  # 避免舊 exe 被鎖住無法覆蓋

    # --clean：避免 build/ 快取讓新的 hiddenimports / collect_all 不生效
    pyinstaller backend.spec --clean --distpath $DIST_BACKEND --workpath "..\..\build-backend" --noconfirm
    if ($LASTEXITCODE -ne 0) { Write-Host "Backend 打包失敗" -ForegroundColor Red; exit 1 }
    Write-Host "Backend 打包完成 → dist-backend/lightrade-backend.exe" -ForegroundColor Green
} else {
    Write-Host "`n[2/4] SKIP backend (使用既有 $DIST_BACKEND)" -ForegroundColor Yellow
}

# ── Step 3: 建置 Electron 應用程式 ───────────────────────────────────────────
Write-Host "`n[3/4] 建置 Electron 應用程式..." -ForegroundColor Yellow
Set-Location "$ROOT\electron"

# 安裝 electron 依賴（首次執行）
if (-not (Test-Path "node_modules")) {
    Write-Host "安裝 Electron 依賴..." -ForegroundColor Gray
    npm install
}

npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Electron 建置失敗" -ForegroundColor Red; exit 1 }

# ── Step 4: 驗收 — 確認打包進 Electron 的檔案確實與來源一致 ──────────────────
Write-Host "`n[4/4] 驗收..." -ForegroundColor Yellow
$backendSrc  = Join-Path $DIST_BACKEND "lightrade-backend.exe"
$backendDst  = Join-Path $UNPACKED_BACKEND "lightrade-backend.exe"
$frontendDst = Join-Path $UNPACKED_FRONTEND "index.html"

if ((Test-Path $backendSrc) -and (Test-Path $backendDst)) {
    $srcHash = (Get-FileHash $backendSrc  -Algorithm SHA1).Hash
    $dstHash = (Get-FileHash $backendDst  -Algorithm SHA1).Hash
    if ($srcHash -eq $dstHash) {
        Write-Host ("  ✓ Backend hash 一致 (" + $srcHash.Substring(0,12) + ")") -ForegroundColor Green
    } else {
        Write-Host "  ⚠ Backend hash 不一致！electron-builder 可能沒複製到新版" -ForegroundColor Red
        Write-Host ("    src: " + $srcHash.Substring(0,12)) -ForegroundColor Gray
        Write-Host ("    dst: " + $dstHash.Substring(0,12)) -ForegroundColor Gray
        Write-Host "    熱覆蓋..." -ForegroundColor Yellow
        Copy-Item $backendSrc $backendDst -Force
    }
} else {
    Write-Host "  ⚠ 找不到 backend 檔案，驗收跳過" -ForegroundColor Yellow
}

if (Test-Path $frontendDst) {
    Write-Host "  ✓ Frontend index.html 已打包" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Frontend 未打包到 Electron resources" -ForegroundColor Red
}

Write-Host "`n======================================" -ForegroundColor Green
Write-Host "  建置完成！" -ForegroundColor Green
Write-Host ("  輸出: " + $DIST_ELECTRON) -ForegroundColor Green
Write-Host "  執行: $DIST_ELECTRON\LighTrade.exe" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
