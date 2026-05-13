'use strict';

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

// ---------------------------------------------------------------------------
// Single-instance lock — 防止使用者雙擊兩次造成兩個 backend 搶 port 8000
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  // 已有另一個 instance 跑著；當前 process 直接退出。
  // 另一個 instance 會在 second-instance 事件聚焦現有視窗（見 lifecycle 區段）。
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKEND_HOST = process.env.LIGHTRADE_HOST || '127.0.0.1';
const BACKEND_PORT = parseInt(process.env.LIGHTRADE_PORT || '8000', 10);
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const IS_DEV = process.env.ELECTRON_DEV === '1';
// Dev mode 預設載 vite dev server（HMR），可用 ELECTRON_DEV_URL 覆寫；
// 若沒設且 ELECTRON_DEV=1，預設 :5173（vite 預設 port）。
const DEV_FRONTEND_URL =
  process.env.ELECTRON_DEV_URL || `http://${BACKEND_HOST}:5173`;
const APP_URL = IS_DEV ? DEV_FRONTEND_URL : BACKEND_URL;
const GITHUB_REPO_URL = 'https://github.com/how0531/LighTrading';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let backendProcess = null;
let isQuitting = false;
let updateCheckTimer = null;

// ---------------------------------------------------------------------------
// Preferences (for "don't ask again" on close)
// ---------------------------------------------------------------------------

function prefsPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function loadPrefs() {
  try {
    const raw = fs.readFileSync(prefsPath(), 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
    fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2), 'utf8');
  } catch (err) {
    console.warn('[prefs] failed to save preferences:', err);
  }
}

// ---------------------------------------------------------------------------
// Backend path resolution
// ---------------------------------------------------------------------------

function resolveBackendBinary() {
  const isPackaged = app.isPackaged;
  const resourcesPath = isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..');
  const exeName =
    process.platform === 'win32' ? 'lightrade-backend.exe' : 'lightrade-backend';
  const backendBinary = path.join(
    resourcesPath,
    'backend',
    'lightrade-backend',
    exeName,
  );
  return { backendBinary, resourcesPath };
}

// Port-busy 預檢：spawn 前先看 8000 是不是被佔。
// 被佔通常代表：使用者開了第二份 LighTrade（已用 single-instance lock 擋）、
// docker compose 正在跑、或自己手動啟動了 backend。給友善訊息直接退出。
function checkPortAvailable(host, port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, host);
  });
}

function resolveFrontendDist() {
  const isPackaged = app.isPackaged;
  const resourcesPath = isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..');
  return path.join(resourcesPath, 'frontend-dist');
}

// ---------------------------------------------------------------------------
// Backend spawn + readiness
// ---------------------------------------------------------------------------

function spawnBackend() {
  const { backendBinary } = resolveBackendBinary();
  const frontendDist = resolveFrontendDist();

  if (!fs.existsSync(backendBinary)) {
    const msg = `Backend binary not found at: ${backendBinary}`;
    console.error('[backend]', msg);
    dialog.showErrorBox('LighTrade', `無法啟動 backend\n${msg}`);
    app.quit();
    return null;
  }

  console.log('[backend] spawning:', backendBinary);

  const env = Object.assign({}, process.env, {
    LIGHTRADE_HOST: BACKEND_HOST,
    LIGHTRADE_PORT: String(BACKEND_PORT),
    LIGHTRADE_FRONTEND_DIST: frontendDist,
  });

  const proc = spawn(backendBinary, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });

  // 立刻把 proc 存到全域 ref；確保 spawn 後若 error/exit 拋出
  // 也能在 before-quit 把它收掉，不會 leak。
  backendProcess = proc;

  // 同時把 backend stdout/stderr 鏡像寫到 userData/logs/backend.log，
  // 方便使用者在打包後的 app crash 後找到原因。
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = fs.createWriteStream(path.join(logsDir, 'backend.log'), { flags: 'a' });
    logFile.write(`\n=== ${new Date().toISOString()} backend spawn ===\n`);
    proc.stdout.pipe(logFile);
    proc.stderr.pipe(logFile);
  } catch (err) {
    console.warn('[backend] log file setup failed:', err);
  }

  proc.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk.toString()}`);
  });
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk.toString()}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[backend] exited code=${code} signal=${signal}`);
    backendProcess = null;
    if (isQuitting) return;
    // 嘗試自動 restart 一次；之後仍掛掉才彈錯誤。
    if (!proc._lightradeRestarted) {
      console.warn('[backend] unexpected exit, attempting one auto-restart');
      setTimeout(() => {
        const next = spawnBackend();
        if (next) next._lightradeRestarted = true;
      }, 500);
      return;
    }
    dialog.showErrorBox(
      'LighTrade',
      `Backend 再次意外終止 (code=${code}, signal=${signal})\n\nlog: ${path.join(app.getPath('userData'), 'logs', 'backend.log')}`,
    );
    app.quit();
  });

  proc.on('error', (err) => {
    console.error('[backend] spawn error:', err);
    // 若已掛 ref 但本身沒成功啟動，仍要清掉避免假性活著
    if (backendProcess === proc) backendProcess = null;
  });

  return proc;
}

function pingHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      `${BACKEND_URL}/api/health`,
      { timeout: 1000 },
      (res) => {
        // Drain response to free socket.
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForBackend({ timeoutMs = 60000, intervalMs = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      const ok = await pingHealth();
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('backend readiness timeout'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: 'LighTrade',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Dev: 載 vite dev server（HMR）；Prod: 載 backend 同 origin 服務的靜態 build
  mainWindow.loadURL(APP_URL).catch((err) => {
    console.error('[window] loadURL failed:', err);
  });
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    const prefs = loadPrefs();
    if (prefs.skipCloseConfirm) return;

    // 用 async showMessageBox 才能拿到 checkbox 狀態（sync 變體拿不到）。
    e.preventDefault();
    dialog
      .showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['取消', '關閉'],
        defaultId: 1,
        cancelId: 0,
        title: 'LighTrade',
        message: '確定要關閉 LighTrade 嗎？',
        checkboxLabel: '不再詢問',
        checkboxChecked: false,
      })
      .then((r) => {
        if (r.response !== 1) return;
        if (r.checkboxChecked) {
          savePrefs({ ...loadPrefs(), skipCloseConfirm: true });
        }
        isQuitting = true;
        mainWindow.close();
      })
      .catch((err) => console.warn('[close] dialog failed:', err));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function openSettingsWindow() {
  if (!mainWindow) return;
  mainWindow.loadURL(`${APP_URL}/settings`).catch(() => {});
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [];

  if (isMac) {
    template.push({
      label: 'LighTrade',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'Cmd+,',
          click: () => openSettingsWindow(),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => mainWindow && mainWindow.reload(),
      },
      {
        label: 'Force Reload',
        accelerator: 'CmdOrCtrl+Shift+R',
        click: () =>
          mainWindow && mainWindow.webContents.reloadIgnoringCache(),
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  const viewSubmenu = [{ role: 'togglefullscreen' }];
  if (IS_DEV) {
    viewSubmenu.push({ role: 'toggleDevTools' });
  }
  template.push({
    label: 'View',
    submenu: viewSubmenu,
  });

  template.push({
    label: 'Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'zoom' }],
  });

  template.push({
    label: 'Help',
    submenu: [
      {
        label: '開啟 GitHub Repo',
        click: () => shell.openExternal(GITHUB_REPO_URL),
      },
      {
        label: '開啟 log 資料夾',
        click: () => {
          try {
            const logsDir = path.join(app.getPath('userData'), 'logs');
            fs.mkdirSync(logsDir, { recursive: true });
            shell.openPath(logsDir);
          } catch (err) {
            dialog.showErrorBox('LighTrade', `無法開啟 log 資料夾：${err.message}`);
          }
        },
      },
      {
        label: '檢查更新',
        // dev 模式 disable 而不是顯示對話框，更符合 UX 預期
        enabled: app.isPackaged,
        click: () => {
          autoUpdater.checkForUpdates().catch((err) => {
            console.warn('[updater] manual check failed:', err);
            dialog.showErrorBox('LighTrade', `檢查更新失敗：${err.message}`);
          });
        },
      },
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ---------------------------------------------------------------------------
// Auto-updater (Phase E)
// ---------------------------------------------------------------------------

function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[updater] skipped (not packaged)');
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.logger = {
    info: (m) => console.log('[updater]', m),
    warn: (m) => console.warn('[updater]', m),
    error: (m) => console.error('[updater]', m),
    debug: (m) => console.log('[updater]', m),
  };

  autoUpdater.on('error', (err) => {
    console.warn('[updater] error:', err && err.message ? err.message : err);
  });

  autoUpdater.on('update-available', async (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-available', info);
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['下載更新', '稍後'],
      defaultId: 0,
      cancelId: 1,
      title: 'LighTrade 更新',
      message: `有新版本可用：${info && info.version ? info.version : ''}`,
      detail: '是否現在下載？',
    });
    if (result.response === 0) {
      autoUpdater.downloadUpdate().catch((err) => {
        console.warn('[updater] downloadUpdate failed:', err);
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] no updates available');
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded', info);
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['立即重啟', '稍後'],
      defaultId: 0,
      cancelId: 1,
      title: 'LighTrade 更新',
      message: '更新已下載完成',
      detail: '重啟應用程式以套用更新。',
    });
    if (result.response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  // Initial + 6h interval.
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[updater] initial check failed:', err);
  });
  updateCheckTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] periodic check failed:', err);
    });
  }, 6 * 60 * 60 * 1000);
}

ipcMain.on('install-update', () => {
  isQuitting = true;
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    console.warn('[updater] quitAndInstall failed:', err);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// 冷啟動 loading splash：在 backend 還沒 ready 前先給使用者一個視覺回饋
let splashWindow = null;
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: process.platform !== 'win32',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; height:100vh; display:flex; flex-direction:column;
         align-items:center; justify-content:center; gap:14px;
         background:#101623; color:#F1F5F9;
         font-family:-apple-system,Segoe UI,sans-serif; }
  .brand { font-size:26px; font-weight:900; letter-spacing:0.2em; font-style:italic;
           color:#D4AF37; text-shadow:0 0 18px rgba(212,175,55,0.4); }
  .msg   { font-size:12px; color:#94A3B8; letter-spacing:0.1em; }
  .bar   { width:240px; height:4px; background:#1C2331; border-radius:2px; overflow:hidden; }
  .bar > i { display:block; width:40%; height:100%;
             background:linear-gradient(90deg, transparent, #D4AF37, transparent);
             animation:slide 1.2s linear infinite; }
  @keyframes slide { 0% { transform:translateX(-100%); } 100% { transform:translateX(340%); } }
</style></head><body>
  <div class="brand">LIGHTRADE</div>
  <div class="bar"><i></i></div>
  <div class="msg">正在連線到交易引擎…</div>
</body></html>`;
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  splashWindow.on('closed', () => { splashWindow = null; });
}

// 第二個 instance 嘗試啟動時，把現有視窗叫回前景而不是真的開新視窗
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  buildMenu();
  createSplash();

  try {
    if (!IS_DEV) {
      // Prod 才會 spawn backend。先預檢 port，被佔就提早 bail。
      const free = await checkPortAvailable(BACKEND_HOST, BACKEND_PORT);
      if (!free) {
        if (splashWindow) splashWindow.destroy();
        dialog.showErrorBox(
          'LighTrade',
          `Port ${BACKEND_PORT} 被佔用，無法啟動 backend。\n\n` +
          '可能原因：\n' +
          '• docker compose 正在跑\n' +
          '• 上一次 LighTrade 沒乾淨退出，殘留 process\n' +
          '• 其他程式佔用此 port\n\n' +
          '請先把佔用的 process 停掉，再重新啟動。',
        );
        app.quit();
        return;
      }
      spawnBackend();
      if (!backendProcess) return; // already errored + quitting
    } else {
      console.log('[dev] expecting backend on', BACKEND_URL, 'frontend on', APP_URL);
    }
    await waitForBackend();
  } catch (err) {
    console.error('[startup] backend not ready:', err);
    if (splashWindow) splashWindow.destroy();
    dialog.showErrorBox('LighTrade', '無法啟動 backend');
    app.quit();
    return;
  }

  createWindow();
  // backend ready → main window 接管，把 splash 關掉
  if (splashWindow) {
    splashWindow.destroy();
    splashWindow = null;
  }
  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  if (backendProcess && !backendProcess.killed) {
    const proc = backendProcess;
    try {
      proc.kill('SIGTERM');
    } catch (err) {
      console.warn('[backend] SIGTERM failed:', err);
    }
    setTimeout(() => {
      if (proc && !proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch (err) {
          console.warn('[backend] SIGKILL failed:', err);
        }
      }
    }, 3000);
  }
});
