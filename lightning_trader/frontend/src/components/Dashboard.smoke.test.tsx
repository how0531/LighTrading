/** Smoke test：整棵 Dashboard 樹（focus mode）能在 jsdom 下渲染（providers/wiring 迴歸網） */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../contexts/ConfirmContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import Dashboard from './Dashboard';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(() => Promise.resolve({ data: {} })),
      post: vi.fn(() => Promise.resolve({ data: {} })),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    },
  };
});

class NoopWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: (() => void) | null = null;
  url: string;
  constructor(url: string) { this.url = url; }
  send() {}
  close() {}
}

describe('Dashboard smoke', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('WebSocket', NoopWebSocket);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders focus-mode dashboard with DOM panel', async () => {
    render(
      <ToastProvider>
        <ConfirmProvider>
          <SettingsProvider>
            <Dashboard />
          </SettingsProvider>
        </ConfirmProvider>
      </ToastProvider>,
    );
    // DOMTable 空狀態文案：預設 targetSymbol=2330、首筆報價未到 → 顯示「訂閱中」骨架
    // （UX 批次 4 Item 11：不再殘留舊資料 / 誤導性的「請輸入商品代碼」）
    expect(await screen.findByText(/訂閱中 2330/)).toBeInTheDocument();
    // focus-mode tab 存在
    expect(screen.getByText('閃電下單')).toBeInTheDocument();
    expect(screen.getByText('K 線')).toBeInTheDocument();
  });
});
