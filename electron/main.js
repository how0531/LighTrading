'use strict';

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKEND_HOST = process.env.LIGHTRADE_HOST || '127.0.0.1';
const BACKEND_PORT = parseInt(process.env.LIGHTRADE_PORT || '8000', 10);
const BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const IS_DEV = process.env.ELECTRON_DEV === '1';
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

  proc.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk.toString()}`);
  });
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk.toString()}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[backend] exited code=${code} signal=${signal}`);
    backendProcess = null;
    if (!isQuitting) {
      dialog.showErrorBox(
        'LighTrade',
        `Backend 已意外終止 (code=${code}, signal=${signal})`,
      );
      app.quit();
    }
  });

  proc.on('error', (err) => {
    console.error('[backend] spawn error:', err);
  });

  backendProcess = proc;
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

  mainWindow.loadURL(BACKEND_URL).catch((err) => {
    console.error('[window] loadURL failed:', err);
  });

  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    const prefs = loadPrefs();
    if (prefs.skipCloseConfirm) return;

    e.preventDefault();
    const result = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['取消', '關閉'],
      defaultId: 1,
      cancelId: 0,
      title: 'LighTrade',
      message: '確定要關閉 LighTrade 嗎？',
      checkboxLabel: '不再詢問',
      checkboxChecked: false,
    });
    // showMessageBoxSync returns the index; checkbox state isn't returned by
    // sync variant, so use async-ish via showMessageBox below as a fallback.
    if (result === 1) {
      isQuitting = true;
      mainWindow.close();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function openSettingsWindow() {
  if (!mainWindow) return;
  mainWindow.loadURL(`${BACKEND_URL}/settings`).catch(() => {});
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
    submenu: [{ role: 'minimize' }, { role: 'zoom' }],
  });

  template.push({
    label: 'Help',
    submenu: [
      {
        label: '開啟 GitHub Repo',
        click: () => shell.openExternal(GITHUB_REPO_URL),
      },
      {
        label: '檢查更新',
        click: () => {
          if (!app.isPackaged) {
            dialog.showMessageBox({
              type: 'info',
              message: '開發模式不檢查更新',
            });
            return;
          }
          autoUpdater.checkForUpdates().catch((err) => {
            console.warn('[updater] manual check failed:', err);
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

app.whenReady().then(async () => {
  buildMenu();

  try {
    if (!IS_DEV) {
      spawnBackend();
      if (!backendProcess) return; // already errored + quitting
    } else {
      console.log('[dev] expecting backend on', BACKEND_URL);
    }
    await waitForBackend();
  } catch (err) {
    console.error('[startup] backend not ready:', err);
    dialog.showErrorBox('LighTrade', '無法啟動 backend');
    app.quit();
    return;
  }

  createWindow();
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
