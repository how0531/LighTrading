/**
 * ConnectionBanner 測試（UX 批次 4 Item 2）
 *
 * 優先序（與 Header 燈號同口徑）：
 *   WS 斷線（紅）＞ 券商重連/斷線（橘）＞ 盤後無 Tick（灰）＞ 正常（不渲染）
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionBanner } from './ConnectionBanner';
import {
  TradingCoreContext,
  type TradingCoreContextType,
  type BrokerState,
} from '../contexts/TradingContext';

function makeCore(overrides: Partial<TradingCoreContextType> = {}): TradingCoreContextType {
  return {
    isConnected: true, isStale: false, isTickStale: false,
    brokerState: 'connected' as BrokerState, recentFills: [], riskAlert: null,
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
    ...overrides,
  };
}

const renderBanner = (overrides: Partial<TradingCoreContextType>) =>
  render(
    <TradingCoreContext.Provider value={makeCore(overrides)}>
      <ConnectionBanner />
    </TradingCoreContext.Provider>,
  );

describe('ConnectionBanner', () => {
  it('WS 斷線 → 紅色「連線中斷，顯示為最後快照」', () => {
    renderBanner({ isConnected: false, isTickStale: true, brokerState: 'unknown' });
    expect(screen.getByTestId('conn-banner')).toHaveTextContent('連線中斷，顯示為最後快照');
  });

  it('券商重連中 → 橘色橫幅（優先於盤後灰）', () => {
    renderBanner({ isConnected: true, isTickStale: true, brokerState: 'reconnecting' });
    expect(screen.getByTestId('conn-banner')).toHaveTextContent('券商連線重建中');
  });

  it('券商斷線 → 橘色橫幅', () => {
    renderBanner({ isConnected: true, brokerState: 'disconnected' });
    expect(screen.getByTestId('conn-banner')).toHaveTextContent('券商連線中斷');
  });

  it('連線正常但無 Tick（盤後）→ 灰色「盤後 / 無行情」', () => {
    renderBanner({ isConnected: true, isTickStale: true, brokerState: 'connected' });
    expect(screen.getByTestId('conn-banner')).toHaveTextContent('盤後 / 無行情');
  });

  it('一切正常 → 不渲染橫幅', () => {
    renderBanner({ isConnected: true, isTickStale: false, brokerState: 'connected' });
    expect(screen.queryByTestId('conn-banner')).toBeNull();
  });
});
