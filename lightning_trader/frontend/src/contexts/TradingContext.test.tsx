/**
 * TradingContext WebSocket 訊息路由測試（mock WebSocket + fake timers）
 *
 * 重點：
 *  1. Tick 訊息 → 100ms throttle flush 後 quote 更新
 *  2. OrderUpdate seq guard：舊 seq 忽略、不觸發委託同步
 *  3. scheduleOrderRefresh：500ms 內重複觸發只補一次 trailing
 *  4. 斷線重連：指數退避（含 ±20% jitter）排程
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { TradingProvider, useTradingContext, type TradingContextType } from './TradingContext';
import { ToastProvider } from './ToastContext';

vi.mock('../api/client', () => ({
  apiClient: {
    get: vi.fn((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [] });
      if (url === '/order_history') return Promise.resolve({ data: { seq_no: 1, orders: [] } });
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

import { apiClient } from '../api/client';
const mockedGet = vi.mocked(apiClient.get);

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) { this.sent.push(data); }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // ── 測試 helpers ──
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  message(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const probe: { ctx: TradingContextType | null } = { ctx: null };
const Probe: React.FC = () => {
  const ctx = useTradingContext();
  React.useEffect(() => { probe.ctx = ctx; });
  return <div data-testid="price">{ctx.quote?.Price ?? 'none'}</div>;
};

const orderHistoryCalls = () =>
  mockedGet.mock.calls.filter((c) => c[0] === '/order_history').length;

async function setup() {
  const utils = render(
    <ToastProvider>
      <TradingProvider>
        <Probe />
      </TradingProvider>
    </ToastProvider>,
  );
  // provider 延遲 50ms 才建立 WebSocket
  await act(async () => { vi.advanceTimersByTime(60); });
  expect(MockWebSocket.instances.length).toBe(1);
  const ws = MockWebSocket.instances[0];
  return { ws, ...utils };
}

describe('TradingContext WS 訊息路由', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    probe.ctx = null;
    vi.clearAllMocks();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Tick 訊息在 100ms flush 後更新 quote', async () => {
    const { ws, getByTestId } = await setup();
    await act(async () => { ws.open(); });

    act(() => {
      ws.message({ type: 'Tick', data: { Symbol: '2330', Price: 123.5, Volume: 2 } });
    });
    // flush 前仍是 buffer 狀態
    expect(getByTestId('price').textContent).toBe('none');

    await act(async () => { vi.advanceTimersByTime(100); });
    expect(getByTestId('price').textContent).toBe('123.5');
    expect(probe.ctx?.quote?.Symbol).toBe('2330');
    // 非 target 商品的 tick 不進主 quote
    act(() => {
      ws.message({ type: 'Tick', data: { Symbol: '9999', Price: 55, Volume: 1 } });
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(getByTestId('price').textContent).toBe('123.5');
  });

  it('OrderUpdate seq guard：舊 seq 忽略，不觸發委託同步', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    await act(async () => { vi.advanceTimersByTime(600); });
    const baseline = orderHistoryCalls(); // 連線後的初始同步

    // 新 seq → 立即同步（leading edge）
    await act(async () => {
      ws.message({ type: 'OrderUpdate', seq_no: 5, data: { status: 'Submitted' } });
    });
    expect(orderHistoryCalls()).toBe(baseline + 1);

    // 舊 seq → 忽略
    await act(async () => { vi.advanceTimersByTime(600); });
    await act(async () => {
      ws.message({ type: 'OrderUpdate', seq_no: 4, data: { status: 'Submitted' } });
    });
    expect(orderHistoryCalls()).toBe(baseline + 1);

    // 更新的 seq → 再同步一次
    await act(async () => {
      ws.message({ type: 'OrderUpdate', seq_no: 6, data: { status: 'Submitted' } });
    });
    expect(orderHistoryCalls()).toBe(baseline + 2);
  });

  it('scheduleOrderRefresh：500ms 內重複觸發只補一次 trailing', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    await act(async () => { vi.advanceTimersByTime(600); });
    const baseline = orderHistoryCalls();

    // 第一發：leading edge 立即執行
    await act(async () => {
      ws.message({ type: 'OrderUpdate', seq_no: 10, data: { status: 'Submitted' } });
    });
    expect(orderHistoryCalls()).toBe(baseline + 1);

    // 500ms 內連兩發 → 不立即執行，只排一個 trailing
    await act(async () => {
      ws.message({ type: 'OrderUpdate', seq_no: 11, data: { status: 'Submitted' } });
      ws.message({ type: 'TradeUpdate', data: { status: 'Filled' } });
    });
    expect(orderHistoryCalls()).toBe(baseline + 1);

    await act(async () => { vi.advanceTimersByTime(500); });
    expect(orderHistoryCalls()).toBe(baseline + 2);
  });

  it('斷線重連：指數退避 + jitter 排程', async () => {
    // Math.random = 0.5 → jitter 係數 = 0.8 + 0.5*0.4 = 1.0（確定性延遲）
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    expect(MockWebSocket.instances.length).toBe(1);

    // 第一次斷線：1000ms 後重連
    await act(async () => { ws.close(); });
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(MockWebSocket.instances.length).toBe(1);
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(MockWebSocket.instances.length).toBe(2);

    // 第二次（未成功 open 即斷線）：退避加倍 → 2000ms
    const ws2 = MockWebSocket.instances[1];
    await act(async () => { ws2.close(); });
    await act(async () => { vi.advanceTimersByTime(1999); });
    expect(MockWebSocket.instances.length).toBe(2);
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(MockWebSocket.instances.length).toBe(3);
  });
});
