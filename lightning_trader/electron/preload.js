// preload.js — 保持 contextIsolation 安全邊界
const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // ── 多視窗：開面板為獨立小窗 ──
  // route: '/panel/dom' | '/panel/positions' | '/panel/history' | ...
  popoutPanel: (route, opts = {}) => ipcRenderer.invoke('popout:open', { route, ...opts }),

  // 查詢 query string（子視窗用來知道自己要 render 哪個 panel）
  getQuery: () => {
    const params = new URLSearchParams(window.location.search)
    const out = {}
    for (const [k, v] of params.entries()) out[k] = v
    return out
  },

  // ── Zoom 控制（快速鍵 Ctrl/Cmd + =/-/0 已由 Electron 預設 menu 提供；
  //    這裡提供程式化介面，讓 UI 也能給按鈕） ──
  zoomIn:    () => webFrame.setZoomLevel(webFrame.getZoomLevel() + 0.5),
  zoomOut:   () => webFrame.setZoomLevel(webFrame.getZoomLevel() - 0.5),
  zoomReset: () => webFrame.setZoomLevel(0),
  getZoom:   () => webFrame.getZoomLevel(),
})
