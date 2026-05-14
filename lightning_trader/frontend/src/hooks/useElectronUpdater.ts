/**
 * useElectronUpdater — 在 Electron 環境下接收 main process 的 auto-update IPC
 *
 * Electron `preload.js` 透過 contextBridge 暴露 `window.lightrade`：
 *   - onUpdateAvailable(cb)     ：偵測到新版
 *   - onUpdateDownloaded(cb)    ：新版已下載，可重啟安裝
 *   - installUpdate()            ：呼叫 quitAndInstall
 *
 * 純瀏覽器 / docker 環境下 `window.lightrade` 不存在，hook 直接 no-op。
 *
 * 本 hook：
 *   - update-available    → toast.info「有新版可用…」
 *   - update-downloaded   → toast.warn「立即重啟安裝」按鈕，按下呼叫 installUpdate
 */
import { useEffect } from 'react';
import { useToast } from '../contexts/ToastContext';

// preload 暴露的 API 介面（與 electron/preload.js 同步）
type ElectronUpdaterAPI = {
  onUpdateAvailable: (cb: (event: unknown, info: { version?: string }) => void) => void;
  onUpdateDownloaded: (cb: (event: unknown, info: { version?: string }) => void) => void;
  installUpdate: () => void;
};

declare global {
  interface Window {
    lightrade?: ElectronUpdaterAPI;
  }
}

export function useElectronUpdater(): void {
  const { toast } = useToast();

  useEffect(() => {
    const api = window.lightrade;
    if (!api) return; // 非 Electron 環境，直接退出

    api.onUpdateAvailable((_e, info) => {
      const v = info?.version ? ` v${info.version}` : '';
      toast.info(`偵測到新版${v}，下載中…`);
    });

    api.onUpdateDownloaded((_e, info) => {
      const v = info?.version ? ` v${info.version}` : '';
      toast.warn(`新版${v} 已下載完成`, {
        actionLabel: '立即重啟安裝',
        durationMs: 30000,
        onAction: () => api.installUpdate(),
      });
    });
  }, [toast]);
}
