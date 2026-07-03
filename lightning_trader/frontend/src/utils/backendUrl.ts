/**
 * backendUrl.ts — 前後端連線 URL 與 API Token 的唯一出處
 *
 * api/client.ts（REST baseURL）與 TradingContext（WebSocket URL）共用同一套
 * host 解析邏輯，避免兩邊各自維護、行為漂移。
 *
 * API Token（選配）：後端設定環境變數 LIGHTRADE_API_TOKEN 時，
 *   - 所有 /api/* 請求（/api/health 除外）需帶 `X-API-Token: <token>` header
 *   - WebSocket URL 需帶 `?token=<token>` query
 * Token 存於 localStorage（key = lightrade_api_token），由 SettingsModal 維護。
 */

export const API_TOKEN_STORAGE_KEY = 'lightrade_api_token';

export function getApiToken(): string {
  try {
    return (window.localStorage.getItem(API_TOKEN_STORAGE_KEY) ?? '').trim();
  } catch {
    return ''; // localStorage 不可用（隱私模式等）→ 視同未設定
  }
}

export function setApiToken(token: string): void {
  try {
    const trimmed = token.trim();
    if (trimmed) window.localStorage.setItem(API_TOKEN_STORAGE_KEY, trimmed);
    else window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
  } catch { /* 靜默：localStorage 不可用時無法持久化 */ }
}

/**
 * Electron packaged build 跑 file:// 協議時，window.location.hostname 會是空字串，
 * 導致組出 "http://:8000/api" 這種無效 URL。固定指向 127.0.0.1；
 * Electron 與瀏覽器 dev 都走本機 backend。
 */
export function resolveBackendHost(): string {
  return window.location.protocol === 'file:' || !window.location.hostname
    ? '127.0.0.1'
    : window.location.hostname;
}

/** REST API base URL（axios baseURL 用） */
export function resolveApiBaseUrl(): string {
  return `http://${resolveBackendHost()}:8000/api`;
}

/**
 * WebSocket URL：與 /api 相同策略 — same-origin，由 vite dev proxy 或 nginx
 * 轉發到 backend；https 站台自動升級成 wss。localhost / file: 直連本機 8000。
 * 有設定 API Token 時附加 ?token=。
 */
export function resolveWsUrl(): string {
  const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  let wsUrl = `${wsScheme}://${window.location.host}/ws/quotes`;
  if (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.protocol === 'file:'
  ) {
    wsUrl = 'ws://127.0.0.1:8000/ws/quotes';
  }
  const token = getApiToken();
  if (token) wsUrl += `?token=${encodeURIComponent(token)}`;
  return wsUrl;
}
