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

  closeWith(code: number) {
    this.readyState = MockWebSocket.CLOSED;
    (this.onclose as unknown as (ev: { code: number }) => void)?.({ code });
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

  it('WorkingOrdersSnapshot 推播：直接套用委託快照（外部管道下單即時出現）', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    await act(async () => { vi.advanceTimersByTime(600); });
    const baseline = orderHistoryCalls();

    const ext = [{ symbol: '2330', action: 'Buy', price: 500, qty: 2,
                   filled_qty: 0, status: 'Submitted', order_id: 'EXT001' }];
    await act(async () => {
      ws.message({ type: 'WorkingOrdersSnapshot', seq_no: 100, data: { orders: ext } });
    });
    // 直接套用，不再打 REST
    expect(orderHistoryCalls()).toBe(baseline);
    expect(probe.ctx?.workingOrders).toHaveLength(1);
    expect(probe.ctx?.workingOrders[0].order_id).toBe('EXT001');

    // 舊 seq 的快照忽略（防亂序）
    await act(async () => {
      ws.message({ type: 'WorkingOrdersSnapshot', seq_no: 99, data: { orders: [] } });
    });
    expect(probe.ctx?.workingOrders).toHaveLength(1);

    // 新 seq 的空快照 → 委託消失（外部刪單）
    await act(async () => {
      ws.message({ type: 'WorkingOrdersSnapshot', seq_no: 101, data: { orders: [] } });
    });
    expect(probe.ctx?.workingOrders).toHaveLength(0);
  });

  it('subscribe 失敗（backend 未登入）→ 2.5 秒後自動重試', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    const subCount = () => ws.sent.filter((s) => s.includes('"subscribe"')).length;
    const initial = subCount(); // onopen 已送 1 次

    await act(async () => {
      ws.message({ action: 'subscribe', status: 'error', symbol: 'TXFR1', message: '尚未登入' });
    });
    expect(subCount()).toBe(initial); // 不立即重送
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(subCount()).toBe(initial + 1); // 2.5 秒後 retry
  });

  it('連線假死（>12 秒無任何訊息）→ 強制 close 觸發自動重連', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    expect(MockWebSocket.instances.length).toBe(1);

    // 13 秒完全沒有訊息（後端 Heartbeat 每 3 秒會發，沒有代表連線已死）
    await act(async () => { vi.advanceTimersByTime(13000); });
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    // onclose → 既有退避重連
    await act(async () => { vi.advanceTimersByTime(1100); });
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('token 認證失敗（4401 close）→ 停止自動重連', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    expect(MockWebSocket.instances.length).toBe(1);

    await act(async () => { ws.closeWith(4401); });
    await act(async () => { vi.advanceTimersByTime(60000); });
    // 帶著同一個壞 token 重連只會無限 4401 —— 不得自動重連
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('subscribe 重試不設次數上限（LIVE 手動登入可能很久）', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    const subCount = () => ws.sent.filter((s) => s.includes('"subscribe"')).length;
    const initial = subCount();

    // 10 輪失敗（超過舊的 8 次上限）—— 每輪都要再重試
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        ws.message({ action: 'subscribe', status: 'error', message: '尚未登入' });
      });
      await act(async () => { vi.advanceTimersByTime(10000); }); // 延遲封頂 10s
      expect(subCount()).toBe(initial + i + 1);
    }
  });

  it('Price=0 但帶 Reference/漲跌停的快照不被丟棄（盤前 ladder 建得起來）', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });

    act(() => {
      ws.message({ type: 'Tick', data: { Symbol: '2330', Price: 0, Reference: 95, LimitUp: 104.5, LimitDown: 85.5 } });
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(probe.ctx?.quote?.Reference).toBe(95);
    expect(probe.ctx?.quote?.LimitUp).toBe(104.5);
    expect(probe.ctx?.quote?.Price).toBe(0);

    // 第一筆真實成交進來後，靜態欄位保留、價格更新
    act(() => {
      ws.message({ type: 'Tick', data: { Symbol: '2330', Price: 96, Volume: 1 } });
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(probe.ctx?.quote?.Price).toBe(96);
    expect(probe.ctx?.quote?.Reference).toBe(95);
  });

  it('watch aliases：tick 帶 canonical symbol 也能更新自選報價', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });

    act(() => { probe.ctx!.watchSymbols(['2330']); });
    await act(async () => {
      ws.message({
        action: 'watch', status: 'success',
        symbols: ['2330'], rejected: [], aliases: { '2330': 'TSE2330' },
      });
    });

    // 後端 tick 廣播帶 canonical（TSE2330）→ 必須映射回自選 key（2330）
    act(() => {
      ws.message({ type: 'Tick', data: { Symbol: 'TSE2330', Price: 600, Volume: 3 } });
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(probe.ctx?.watchlistQuotes['2330']?.price).toBe(600);
  });

  it('Tick 帶 TotalVolume：直接覆蓋累計量；沒帶則沿用前端累加 fallback', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });

    act(() => { probe.ctx!.watchSymbols(['2330']); });

    // 兩筆不帶 TotalVolume 的 tick → 前端累加 3 + 2 = 5
    act(() => {
      ws.message({ type: 'Tick', data: { Symbol: '2330', Price: 600, Volume: 3 } });
      ws.message({ type: 'Tick', data: { Symbol: '2330', Price: 601, Volume: 2 } });
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(probe.ctx?.watchlistQuotes['2330']?.volume).toBe(5);

    // 帶 TotalVolume 的 tick → 直接以交易所累計量覆蓋（自癒，不受先前累加影響）
    act(() => {
      ws.message({ type: 'Tick', data: { Symbol: '2330', Price: 602, Volume: 1, TotalVolume: 1234 } });
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(probe.ctx?.watchlistQuotes['2330']?.volume).toBe(1234);

    // 之後又出現不帶 TotalVolume 的 tick → 從已覆蓋的值繼續累加
    act(() => {
      ws.message({ type: 'Tick', data: { Symbol: '2330', Price: 603, Volume: 4 } });
    });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(probe.ctx?.watchlistQuotes['2330']?.volume).toBe(1238);
  });

  it('TradeUpdate 成交事件 → recentFills（正規化 + 重複 id 忽略）', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });

    // Shioaji deal callback 風格欄位（code / quantity / ordno / id）
    await act(async () => {
      ws.message({
        type: 'TradeUpdate',
        data: { id: 'D1', code: '2330', action: 'Buy', price: 600, quantity: 2, ordno: 'A001' },
      });
    });
    expect(probe.ctx?.recentFills).toHaveLength(1);
    expect(probe.ctx?.recentFills[0]).toMatchObject({
      id: 'D1', symbol: '2330', action: 'Buy', price: 600, qty: 2,
    });

    // 重複 id → 忽略（不新增）
    await act(async () => {
      ws.message({
        type: 'TradeUpdate',
        data: { id: 'D1', code: '2330', action: 'Buy', price: 600, quantity: 2 },
      });
    });
    expect(probe.ctx?.recentFills).toHaveLength(1);

    // 無 id → compound fallback（order_id#price#qty）；SyncDeal 風格欄位（symbol / qty / order_id）
    await act(async () => {
      ws.message({
        type: 'TradeUpdate',
        data: { symbol: '2330', action: 'Sell', price: 601, qty: 1, order_id: 'B001' },
      });
    });
    expect(probe.ctx?.recentFills).toHaveLength(2);
    // 新的在前
    expect(probe.ctx?.recentFills[0]).toMatchObject({
      id: 'B001#601#1', symbol: '2330', action: 'Sell', price: 601, qty: 1,
    });

    // 純狀態回報（無 symbol / qty）不進 recentFills
    await act(async () => {
      ws.message({ type: 'TradeUpdate', data: { status: 'Filled' } });
    });
    expect(probe.ctx?.recentFills).toHaveLength(2);
  });

  it('ConnectionState → brokerState 更新；WS 斷線重設為 unknown', async () => {
    const { ws } = await setup();
    expect(probe.ctx?.brokerState).toBe('unknown');
    await act(async () => { ws.open(); });

    // hello frame
    await act(async () => {
      ws.message({ type: 'ConnectionState', data: { broker: 'connected' } });
    });
    expect(probe.ctx?.brokerState).toBe('connected');

    await act(async () => {
      ws.message({ type: 'ConnectionState', data: { broker: 'reconnecting' } });
    });
    expect(probe.ctx?.brokerState).toBe('reconnecting');

    // 未知值忽略
    await act(async () => {
      ws.message({ type: 'ConnectionState', data: { broker: 'weird' } });
    });
    expect(probe.ctx?.brokerState).toBe('reconnecting');

    // WS 斷線 → 券商狀態未知
    await act(async () => { ws.close(); });
    expect(probe.ctx?.brokerState).toBe('unknown');
  });

  it('自選移除 → POST /unwatch 退訂背景報價（只送被移除的 symbol）', async () => {
    const { ws } = await setup();
    await act(async () => { ws.open(); });
    const mockedPost = vi.mocked(apiClient.post);

    act(() => { probe.ctx!.watchSymbols(['2330', '2890']); });
    // 加入清單不觸發退訂
    expect(mockedPost.mock.calls.filter((c) => c[0] === '/unwatch')).toHaveLength(0);
    mockedPost.mockClear();

    // 移除 2890 → 呼叫退訂 API，且只帶被移除的 symbol
    // （targetSymbol / 持倉商品的保護在後端 /unwatch 以 canonical 比對處理）
    act(() => { probe.ctx!.watchSymbols(['2330']); });
    const unwatchCalls = mockedPost.mock.calls.filter((c) => c[0] === '/unwatch');
    expect(unwatchCalls).toHaveLength(1);
    expect(unwatchCalls[0][1]).toEqual({ symbols: ['2890'] });

    // 清單不變 → 不重複退訂
    act(() => { probe.ctx!.watchSymbols(['2330']); });
    expect(mockedPost.mock.calls.filter((c) => c[0] === '/unwatch')).toHaveLength(1);
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
