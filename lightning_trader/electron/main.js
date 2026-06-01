const path = require('path')
const { spawn } = require('child_process')
const http = require('http')
const { app, BrowserWindow, shell, ipcMain } = require('electron')

// dev mode: running via `electron .` (not packaged)
const isDev = process.defaultApp === true || process.env.ELECTRON_DEV === '1'
const BACKEND_PORT = 8000
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

let mainWindow = null
let backendProcess = null
const popoutWindows = new Set()  // 追蹤所有子視窗

// ── 啟動 Python Backend ──────────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    let exe, args, cwd

    if (isDev) {
      // 開發模式：直接用 python 執行
      const backendEntry = path.join(__dirname, '..', 'backend_entry.py')
      exe = 'python'
      args = [backendEntry]
      cwd = path.join(__dirname, '..')
    } else {
      // 生產模式：執行 PyInstaller 打包的 exe
      exe = path.join(process.resourcesPath, 'backend', 'lightrade-backend.exe')
      args = []
      cwd = path.join(process.resourcesPath, 'backend')
    }

    console.log(`[Backend] 啟動: ${exe} ${args.join(' ')}`)

    backendProcess = spawn(exe, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    backendProcess.stdout.on('data', (data) => {
      console.log(`[Backend] ${data.toString().trim()}`)
    })

    backendProcess.stderr.on('data', (data) => {
      console.error(`[Backend ERR] ${data.toString().trim()}`)
    })

    backendProcess.on('error', (err) => {
      console.error('[Backend] 無法啟動:', err)
      reject(err)
    })

    backendProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[Backend] 異常退出，代碼: ${code}`)
      }
    })

    // 等待 backend 就緒
    waitForBackend(30).then(resolve).catch(reject)
  })
}

// ── 輪詢等待 Backend 就緒 ────────────────────────────────────────────────────
function waitForBackend(maxRetries = 30) {
  return new Promise((resolve, reject) => {
    let retries = 0

    const check = () => {
      http.get(`${BACKEND_URL}/api/accounts`, (res) => {
        console.log(`[Backend] 就緒！(HTTP ${res.statusCode})`)
        resolve()
      }).on('error', () => {
        retries++
        if (retries >= maxRetries) {
          reject(new Error('Backend 啟動逾時'))
          return
        }
        setTimeout(check, 1000)
      })
    }

    // 第一次等 2 秒再開始輪詢（backend 需要初始化時間）
    setTimeout(check, 2000)
  })
}

// ── 計算前端 index.html 路徑 + 用 hash route 組合完整 URL ──────────────────
function getFrontendUrl(hashRoute = '/dashboard', query = null) {
  const indexPath = isDev
    ? null  // dev 模式直接回 dev server URL
    : path.join(process.resourcesPath, 'frontend', 'dist', 'index.html')
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  if (isDev) {
    return `http://localhost:5173/${qs}#${hashRoute}`
  }
  // file:// URL — Electron loadFile 不支援 hash，得用 loadURL
  const fileUrl = 'file:///' + indexPath.replace(/\\/g, '/') + qs + '#' + hashRoute
  return fileUrl
}

// ── 建立主視窗 ───────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // 放寬：允許縮到極小（320x240），支援多視窗小窗排列 / 雙螢幕
    minWidth: 320,
    minHeight: 240,
    title: 'LighTrade - 閃電下單',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    // 開發模式：載入 Vite dev server
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    // 生產模式：載入打包的 React 靜態檔案（含預設 hash route /dashboard）
    mainWindow.loadURL(getFrontendUrl('/'))
  }

  // 外部連結用瀏覽器開啟
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // 主視窗關閉時把所有子視窗也收掉
    for (const w of popoutWindows) {
      if (!w.isDestroyed()) w.close()
    }
    popoutWindows.clear()
  })
}

// ── 建立子視窗（彈出 panel） ─────────────────────────────────────────────────
function createPopoutWindow({ route, title, width, height, parent }) {
  const win = new BrowserWindow({
    width:  width  || 480,
    height: height || 600,
    minWidth:  260,
    minHeight: 200,
    title: title || 'LighTrade Panel',
    backgroundColor: '#0f0f0f',
    parent: parent ? mainWindow : undefined,  // 不設 parent 才能獨立拖到別螢幕
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // query 帶 popout=1 讓前端知道自己是子視窗（可隱藏 header/nav）
  const url = isDev
    ? `http://localhost:5173/?popout=1#${route}`
    : getFrontendUrl(route, { popout: '1' })
  win.loadURL(url)

  win.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u)
    return { action: 'deny' }
  })

  popoutWindows.add(win)
  win.on('closed', () => { popoutWindows.delete(win) })
  return win
}

// ── IPC：renderer 要求開子視窗 ───────────────────────────────────────────────
ipcMain.handle('popout:open', (_evt, opts) => {
  const w = createPopoutWindow(opts || {})
  return { id: w.id }
})

// ── App 生命週期 ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    console.log('[App] 啟動 Backend...')
    await startBackend()
    console.log('[App] 建立視窗...')
    createWindow()
  } catch (err) {
    console.error('[App] 啟動失敗:', err)
    app.quit()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killBackend()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  killBackend()
})

// ── 終止 Backend ─────────────────────────────────────────────────────────────
function killBackend() {
  if (backendProcess) {
    console.log('[Backend] 正在關閉...')
    backendProcess.kill('SIGTERM')
    backendProcess = null
  }
}
