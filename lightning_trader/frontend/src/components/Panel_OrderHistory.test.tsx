/**
 * Panel_OrderHistory — 部分成交徽章測試（UX 批次 4 Item 5）
 *
 * 活躍且 0 < filled_qty < qty 的委託列要顯示「filled/qty」琥珀色進度徽章；
 * 全成 / 未成交的列不顯示。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import Panel_OrderHistory from './Panel_OrderHistory';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../contexts/ConfirmContext';
import {
  TradingCoreContext,
  type TradingCoreContextType,
} from '../contexts/TradingContext';

const { mockGetOrderHistory } = vi.hoisted(() => ({
  mockGetOrderHistory: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getOrderHistory: mockGetOrderHistory,
    apiClient: {
      get: vi.fn(() => Promise.resolve({ data: [] })),
      post: vi.fn(() => Promise.resolve({ data: {} })),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
    },
  };
});

function makeCore(): TradingCoreContextType {
  return {
    isConnected: true, isStale: false, isTickStale: false,
    brokerState: 'connected', recentFills: [], riskAlert: null,
    targetSymbol: '2330', setTargetSymbol: vi.fn(),
    watchSymbols: vi.fn(), setAuxWatch: vi.fn(),
    accountSummary: { '當日交易': 0, '參考損益': 0, positions: [], is_simulation: true, msg_count: 0 },
    accounts: [], activeAccount: null,
    workingOrders: [], setWorkingOrders: vi.fn(),
    refreshOrders: vi.fn(async () => {}),
    scheduleOrderRefresh: vi.fn(),
    syncAll: vi.fn(async () => {}),
    forceReconnect: vi.fn(),
    subscribe: vi.fn(),
    selectAccount: vi.fn(async () => {}),
    cancelOrder: vi.fn(async () => {}),
    flattenPosition: vi.fn(async () => {}),
    smartOrders: [], refreshSmartOrders: vi.fn(async () => {}),
  };
}

const renderPanel = () =>
  render(
    <ToastProvider>
      <ConfirmProvider>
        <TradingCoreContext.Provider value={makeCore()}>
          <Panel_OrderHistory />
        </TradingCoreContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );

describe('Panel_OrderHistory 部分成交徽章', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('部分成交列顯示 filled/qty 進度徽章 + 部分成交狀態', async () => {
    mockGetOrderHistory.mockResolvedValue([
      {
        time: '2026-07-05T09:01:00.000', symbol: '2330', action: 'Buy',
        price: 500, qty: 10, status: 'PartFilled',
        filled_qty: 3, filled_avg_price: 499.5,
      },
    ]);
    renderPanel();
    const badge = await screen.findByText('3/10');
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('title')).toContain('部分成交');
    expect(screen.getByText('部分成交')).toBeInTheDocument();
  });

  it('全成 / 零成交的列不顯示進度徽章', async () => {
    mockGetOrderHistory.mockResolvedValue([
      {
        time: '2026-07-05T09:01:00.000', symbol: '2330', action: 'Buy',
        price: 500, qty: 5, status: 'Filled',
        filled_qty: 5, filled_avg_price: 500,
      },
      {
        time: '2026-07-05T09:02:00.000', symbol: '2330', action: 'Sell',
        price: 505, qty: 2, status: 'Submitted',
        filled_qty: 0, filled_avg_price: 0,
      },
    ]);
    renderPanel();
    expect(await screen.findByText('已成交')).toBeInTheDocument();
    expect(screen.queryByText('5/5')).toBeNull();
    expect(screen.queryByText('0/2')).toBeNull();
  });
});
