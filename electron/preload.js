const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lightrade', {
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', cb),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', cb),
  installUpdate: () => ipcRenderer.send('install-update'),
});
