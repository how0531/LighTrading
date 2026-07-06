/**
 * useMiniDomOrder（⚡全開宮格下單）測試 — Sprint D
 *
 * 重點：
 *  1. 點擊下單 payload：symbol / action / price / qty 正確、LMT 限價、預設 ROD/Cash/Common
 *  2. 非戰鬥模式：確認框（文案含商品代碼）拒絕 → 完全不送單
 *  3. 戰鬥模式：跳過確認直送
 *  4. in-flight 去重「按商品隔離」：同商品連點擋下、不同商品互不阻擋
 *  5. 後端 409 CONFIRM_REQUIRED → danger 確認 → 同 payload + confirm:true 重送
 *     （核心共用 utils/orderExec.placeOrderWithRiskConfirm，與主 DOM 同一條路）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { useMiniDomOrder } from './useMiniDomOrder';
import { TradingCoreContext, type TradingCoreContextType } from '../contexts/TradingContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../contexts/ToastContext';
import type { ConfirmOptions } from '../contexts/ConfirmContext';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(() => Promise.resolve({ data: {} })),
      post: vi.fn(() => Promise.resolve({ data: {} })),
    },
  };
});

const { mockConfirm, mockConfirmWithInput } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockConfirmWithInput: vi.fn(),
}));
vi.mock('../contexts/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithInput: mockConfirmWithInput }),
}));

import { apiClient } from '../api/client';
const mockedPost = vi.mocked(apiClient.post);

function makeCoreValue(): TradingCoreContextType {
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

let coreValue: TradingCoreContextType;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>
    <SettingsProvider>
      <TradingCoreContext.Provider value={coreValue}>
        {children}
      </TradingCoreContext.Provider>
    </SettingsProvider>
  </ToastProvider>
);

/** 後端 409 CONFIRM_REQUIRED（RiskManager WARNING，缺 confirm:true） */
function confirmRequiredError(): AxiosError {
  const response = {
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: {} as InternalAxiosRequestConfig,
    data: {
      detail: {
        code: 'CONFIRM_REQUIRED',
        user_msg: '此單需要確認',
        warnings: ['價格偏離參考價 3%'],
      },
    },
  } as AxiosResponse;
  return new AxiosError('Request failed with status code 409', 'ERR_BAD_REQUEST', undefined, undefined, response);
}

const EXPECTED_GRID_PAYLOAD = {
  symbol: '2454', price: 995, action: 'Buy', qty: 3,
  order_type: 'ROD', price_type: 'LMT', order_cond: 'Cash', order_lot: 'Common',
};

describe('useMiniDomOrder（戰鬥模式：直送）', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('lightrade_settings', JSON.stringify({ isCombatMode: true }));
    coreValue = makeCoreValue();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockedPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('點買側 → POST /place_order，payload symbol/action/price/qty 正確（LMT 限價）', async () => {
    const { result } = renderHook(() => useMiniDomOrder(), { wrapper });
    await act(async () => {
      await result.current.placeFromGrid('2454', 995, 'Buy', 3);
    });
    expect(mockConfirm).not.toHaveBeenCalled(); // 戰鬥模式：跳過前端確認
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/place_order', EXPECTED_GRID_PAYLOAD);
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });

  it('點賣側 → action=Sell；symbol 正規化（小寫/空白 → 大寫）', async () => {
    const { result } = renderHook(() => useMiniDomOrder(), { wrapper });
    await act(async () => {
      await result.current.placeFromGrid(' txfr1 ', 17500, 'Sell', 2);
    });
    expect(mockedPost).toHaveBeenCalledWith('/place_order',
      expect.objectContaining({ symbol: 'TXFR1', price: 17500, action: 'Sell', qty: 2, price_type: 'LMT' }));
  });

  it('無效輸入（price<=0 / qty<=0 / 空 symbol）不送單', async () => {
    const { result } = renderHook(() => useMiniDomOrder(), { wrapper });
    await act(async () => {
      await result.current.placeFromGrid('2330', 0, 'Buy', 1);
      await result.current.placeFromGrid('2330', 100, 'Buy', 0);
      await result.current.placeFromGrid('', 100, 'Buy', 1);
    });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('in-flight 去重按商品隔離：同商品連點擋下、不同商品照送', async () => {
    // 第一筆掛住不 resolve，模擬送出中
    let releaseFirst: (v: { data: object }) => void = () => {};
    mockedPost.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = resolve; }),
    );
    const { result } = renderHook(() => useMiniDomOrder(), { wrapper });

    let p1: Promise<void> = Promise.resolve();
    let p2: Promise<void> = Promise.resolve();
    let p3: Promise<void> = Promise.resolve();
    act(() => {
      p1 = result.current.placeFromGrid('2330', 600, 'Buy', 1);  // 掛住
      p2 = result.current.placeFromGrid('2330', 601, 'Buy', 1);  // 同商品 → 被擋
      p3 = result.current.placeFromGrid('2454', 995, 'Sell', 1); // 不同商品 → 照送
    });
    await act(async () => { await p2; await p3; });
    // 2330 只有一筆、2454 一筆
    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(mockedPost.mock.calls[0][1]).toMatchObject({ symbol: '2330', price: 600 });
    expect(mockedPost.mock.calls[1][1]).toMatchObject({ symbol: '2454', price: 995, action: 'Sell' });

    // 第一筆完成後同商品可再送
    await act(async () => { releaseFirst({ data: {} }); await p1; });
    await act(async () => {
      await result.current.placeFromGrid('2330', 602, 'Buy', 1);
    });
    expect(mockedPost).toHaveBeenCalledTimes(3);
    expect(mockedPost.mock.calls[2][1]).toMatchObject({ symbol: '2330', price: 602 });
  });

  it('409 CONFIRM_REQUIRED → danger 確認接受 → 同 payload + confirm:true 重送', async () => {
    mockedPost
      .mockRejectedValueOnce(confirmRequiredError())
      .mockResolvedValueOnce({ data: {} });
    mockConfirm.mockResolvedValue(true);

    const { result } = renderHook(() => useMiniDomOrder(), { wrapper });
    await act(async () => {
      await result.current.placeFromGrid('2454', 995, 'Buy', 3);
    });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const opts = mockConfirm.mock.calls[0][0] as ConfirmOptions;
    expect(opts.danger).toBe(true);
    expect(opts.message).toContain('此單需要確認');
    expect(opts.message).toContain('價格偏離參考價 3%');

    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(mockedPost.mock.calls[0]).toEqual(['/place_order', EXPECTED_GRID_PAYLOAD]);
    expect(mockedPost.mock.calls[1]).toEqual(['/place_order', { ...EXPECTED_GRID_PAYLOAD, confirm: true }]);
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });

  it('409 CONFIRM_REQUIRED → 拒絕 → 不重送、不觸發委託同步', async () => {
    mockedPost.mockRejectedValueOnce(confirmRequiredError());
    mockConfirm.mockResolvedValue(false);

    const { result } = renderHook(() => useMiniDomOrder(), { wrapper });
    await act(async () => {
      await result.current.placeFromGrid('2454', 995, 'Buy', 3);
    });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(coreValue.scheduleOrderRefresh).not.toHaveBeenCalled();
  });
});

describe('useMiniDomOrder（非戰鬥模式：確認流）', () => {
  beforeEach(() => {
    localStorage.clear(); // 預設：confirmations.placeOrder=true、非戰鬥
    coreValue = makeCoreValue();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockedPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('確認框文案含商品代碼；拒絕 → 完全不送單', async () => {
    mockConfirm.mockResolvedValue(false);
    const { result } = renderHook(() => useMiniDomOrder(), { wrapper });
    await act(async () => {
      await result.current.placeFromGrid('2454', 995, 'Sell', 2);
    });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const opts = mockConfirm.mock.calls[0][0] as ConfirmOptions;
    expect(opts.message).toContain('2454'); // 宮格同時盯多檔，文案必須標明商品
    expect(opts.message).toContain('賣出');
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('確認框接受 → 送單且帶 confirm:true（前端確認一併授權後端 WARNING）', async () => {
    mockConfirm.mockResolvedValue(true);
    const { result } = renderHook(() => useMiniDomOrder(), { wrapper });
    await act(async () => {
      await result.current.placeFromGrid('2454', 995, 'Buy', 3);
    });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/place_order',
      { ...EXPECTED_GRID_PAYLOAD, confirm: true });
  });
});
