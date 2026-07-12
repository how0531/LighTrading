/**
 * HealthStrip 測試 — 正常渲染 + 端點失敗優雅降級。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import HealthStrip from './HealthStrip';
import type { SafetyHealth } from '../api/client';

const { mockGetSafetyHealth } = vi.hoisted(() => ({ mockGetSafetyHealth: vi.fn() }));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getSafetyHealth: mockGetSafetyHealth };
});

const baseHealth: SafetyHealth = {
  status: 'ok',
  risk: {
    halted: false,
    trading_enabled: true,
    daily_total_pnl: 0,
    max_daily_loss: -50000,
    daily_order_count: 10,
    max_orders_per_day: 100,
    daily_notional: 0,
    max_notional_per_day: 0,
    panic_rate: 0,
  },
  invariant_enforce: false,
  last_reconciliation: null,
  connection: { shioaji_connected: true, ws_clients: 1 },
};

describe('HealthStrip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('正常態：顯示「安全」、下單筆數/上限、對帳落差', async () => {
    mockGetSafetyHealth.mockResolvedValue({
      ...baseHealth,
      last_reconciliation: {
        available: true, computed: 100, broker_reported: 105,
        delta: 5, within_threshold: true, threshold: 10, ts: 1,
      },
    });
    render(<HealthStrip />);

    expect(await screen.findByText('安全')).toBeInTheDocument();
    const orders = screen.getByTestId('health-orders');
    expect(orders).toHaveTextContent('10');
    expect(orders).toHaveTextContent('100');
    expect(screen.getByTestId('health-recon')).toHaveTextContent('5');
  });

  it('熔斷態：交易停用時顯示「熔斷」', async () => {
    mockGetSafetyHealth.mockResolvedValue({
      ...baseHealth,
      risk: { ...baseHealth.risk!, halted: true, trading_enabled: false },
    });
    render(<HealthStrip />);
    expect(await screen.findByText('熔斷')).toBeInTheDocument();
  });

  it('端點失敗 → 優雅降級為「—」，不 throw、不顯示對帳列', async () => {
    mockGetSafetyHealth.mockRejectedValue(new Error('503'));
    render(<HealthStrip />);

    // strip 仍渲染
    expect(screen.getByTestId('health-strip')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('health-trading')).toHaveTextContent('—');
    });
    expect(screen.getByTestId('health-orders')).toHaveTextContent('—');
    expect(screen.queryByTestId('health-recon')).toBeNull();
  });
});
