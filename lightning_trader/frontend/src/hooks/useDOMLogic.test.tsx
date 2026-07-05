/**
 * useDOMLogic 下單流程測試
 *
 * 重點：
 *  1. 限價單 POST payload 形狀正確
 *  2. 409 CONFIRM_REQUIRED → ConfirmDialog 接受 → 以相同 payload + confirm:true 重送
 *  3. ConfirmDialog 拒絕 → 不會有第二次 POST
 *  4. 刪單走 /cancel_all 並帶正確參數
 *
 * 確認流已改用 useConfirm（promise-based ConfirmDialog，UX 批次 3），
 * 這裡 mock useConfirm 直接控制 resolve true/false；對話框本身的互動
 * 行為（Enter/Esc/backdrop/排隊）由 ConfirmContext.test.tsx 覆蓋。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { useDOMLogic } from './useDOMLogic';
import {
  QuotesContext, TradingCoreContext,
  type QuotesContextType, type TradingCoreContextType,
} from '../contexts/TradingContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../contexts/ToastContext';
import type { ConfirmOptions } from '../contexts/ConfirmContext';
import type { QuoteData } from '../types';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    apiClient: {
      get: vi.fn(() => Promise.resolve({ data: {} })),
      post: vi.fn(() => Promise.resolve({ data: {} })),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
    },
  };
});

// mock useConfirm：測試直接控制確認結果（true=確認 / false=取消）
const { mockConfirm, mockConfirmWithInput } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockConfirmWithInput: vi.fn(),
}));
vi.mock('../contexts/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithInput: mockConfirmWithInput }),
}));

// 取得 mock 後的 apiClient（vi.mock hoisting 保證這裡拿到的是 mock）
import { apiClient } from '../api/client';
const mockedPost = vi.mocked(apiClient.post);

const quoteStub: QuoteData = {
  Symbol: '2330', Price: 100, Volume: 1, Reference: 100,
  TickTime: '09:00:00', Action: '',
};

const quotesValue: QuotesContextType = {
  quote: quoteStub,
  bidAsk: null,
  quoteHistory: [],
  watchlistQuotes: {},
  realtimePositions: [],
  totalRealtimePnl: 0,
  totalRealizedPnl: 0,
};

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
        <QuotesContext.Provider value={quotesValue}>
          {children}
        </QuotesContext.Provider>
      </TradingCoreContext.Provider>
    </SettingsProvider>
  </ToastProvider>
);

/** 後端 409 CONFIRM_REQUIRED 回應（RiskManager WARNING，缺 confirm:true） */
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
        warnings: ['市價單風險', '價格偏離參考價 3%'],
      },
    },
  } as AxiosResponse;
  return new AxiosError('Request failed with status code 409', 'ERR_BAD_REQUEST', undefined, undefined, response);
}

const EXPECTED_LIMIT_PAYLOAD = {
  symbol: '2330', price: 100, action: 'Buy', qty: 1,
  order_type: 'ROD', price_type: 'LMT', order_cond: 'Cash', order_lot: 'Common',
};

describe('useDOMLogic 下單', () => {
  beforeEach(() => {
    localStorage.clear();
    // 戰鬥模式：跳過前端二次確認，專注測 API 層行為（payload / 409 / 刪單）
    localStorage.setItem('lightrade_settings', JSON.stringify({ isCombatMode: true }));
    coreValue = makeCoreValue();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockedPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('限價單：POST /place_order 的 payload 形狀正確', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper });

    await act(async () => {
      await result.current.handlePlaceOrder(100, 'Buy');
    });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/place_order', EXPECTED_LIMIT_PAYLOAD);
    // 下單成功 → 觸發 debounced 委託同步
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });

  it('409 CONFIRM_REQUIRED + 使用者確認 → 以相同 payload 加 confirm:true 重送', async () => {
    mockedPost
      .mockRejectedValueOnce(confirmRequiredError())
      .mockResolvedValueOnce({ data: {} });
    mockConfirm.mockResolvedValue(true);

    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    await act(async () => {
      await result.current.handlePlaceOrder(100, 'Buy');
    });

    // confirm 內容要包含 user_msg 與 warnings，且用 danger 樣式呈現風控警告
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmOpts = mockConfirm.mock.calls[0][0] as ConfirmOptions;
    expect(confirmOpts.danger).toBe(true);
    expect(confirmOpts.message).toContain('此單需要確認');
    expect(confirmOpts.message).toContain('市價單風險');
    expect(confirmOpts.message).toContain('價格偏離參考價 3%');

    expect(mockedPost).toHaveBeenCalledTimes(2);
    // 第一次：原始 payload（無 confirm）
    expect(mockedPost.mock.calls[0]).toEqual(['/place_order', EXPECTED_LIMIT_PAYLOAD]);
    // 第二次：相同 payload + confirm:true
    expect(mockedPost.mock.calls[1]).toEqual(['/place_order', { ...EXPECTED_LIMIT_PAYLOAD, confirm: true }]);
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });

  it('409 CONFIRM_REQUIRED + 使用者拒絕 → 不會有第二次 POST', async () => {
    mockedPost.mockRejectedValueOnce(confirmRequiredError());
    mockConfirm.mockResolvedValue(false);

    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    await act(async () => {
      await result.current.handlePlaceOrder(100, 'Buy');
    });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(coreValue.scheduleOrderRefresh).not.toHaveBeenCalled();
    // 取消後不留下 pending/error 閃爍
    expect(result.current.orderFeedback).toBeNull();
  });

  it('刪單：POST /cancel_all 帶 symbol/action/price', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper });

    await act(async () => {
      await result.current.handleCancelOrder('Sell', 101.5);
    });

    expect(mockedPost).toHaveBeenCalledWith('/cancel_all', { symbol: '2330', action: 'Sell', price: 101.5 });
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });
});

describe('useDOMLogic 前端確認（非戰鬥模式）', () => {
  beforeEach(() => {
    localStorage.clear();
    // 非戰鬥模式 + 下單確認開啟（皆為預設）
    coreValue = makeCoreValue();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockedPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('確認框拒絕 → 完全不送單', async () => {
    mockConfirm.mockResolvedValue(false);
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('確認框接受 → 送單且帶 confirm:true（前端確認一併授權後端 WARNING）', async () => {
    mockConfirm.mockResolvedValue(true);
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/place_order',
      expect.objectContaining({ symbol: '2330', price: 100, action: 'Buy', confirm: true }));
  });

  it('刪單確認拒絕 → 不送 /cancel_all', async () => {
    mockConfirm.mockResolvedValue(false);
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    await act(async () => { await result.current.handleCancelOrder('Sell', 101.5); });
    expect(mockedPost).not.toHaveBeenCalled();
  });
});

// ─── UX 批次 4 Item 8：追買 / 追賣 / 市價熱鍵 ────────────────

const quotesWithBook: QuotesContextType = {
  ...quotesValue,
  bidAsk: {
    Symbol: '2330',
    BidPrice: [99.5], BidVolume: [10],
    AskPrice: [100.5], AskVolume: [8],
    Time: '09:00:00',
  },
};

const wrapperWithBook = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>
    <SettingsProvider>
      <TradingCoreContext.Provider value={coreValue}>
        <QuotesContext.Provider value={quotesWithBook}>
          {children}
        </QuotesContext.Provider>
      </TradingCoreContext.Provider>
    </SettingsProvider>
  </ToastProvider>
);

describe('useDOMLogic 追價 / 市價熱鍵', () => {
  beforeEach(() => {
    localStorage.clear();
    // 戰鬥模式：一鍵直送，聚焦驗證 payload
    localStorage.setItem('lightrade_settings', JSON.stringify({ isCombatMode: true }));
    coreValue = makeCoreValue();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockedPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('追買：以賣一價掛買（限價）', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper: wrapperWithBook });
    await act(async () => { await result.current.handleChaseOrder('Buy'); });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/place_order',
      expect.objectContaining({ symbol: '2330', price: 100.5, action: 'Buy', price_type: 'LMT' }));
  });

  it('追賣：以買一價掛賣（限價）', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper: wrapperWithBook });
    await act(async () => { await result.current.handleChaseOrder('Sell'); });
    expect(mockedPost).toHaveBeenCalledWith('/place_order',
      expect.objectContaining({ symbol: '2330', price: 99.5, action: 'Sell', price_type: 'LMT' }));
  });

  it('市價熱鍵：price=0 + price_type MKT，且不改使用者的 priceType 選單', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper: wrapperWithBook });
    await act(async () => { await result.current.handleMarketOrder('Sell'); });
    expect(mockedPost).toHaveBeenCalledWith('/place_order',
      expect.objectContaining({ price: 0, action: 'Sell', price_type: 'MKT' }));
    expect(result.current.priceType).toBe('LMT'); // 選單狀態不被市價熱鍵污染
  });

  it('無賣一價（bidAsk 缺）→ 追買不送單', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper }); // bidAsk: null
    await act(async () => { await result.current.handleChaseOrder('Buy'); });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('非戰鬥模式：追買也要走確認流（拒絕 → 不送單）', async () => {
    localStorage.clear(); // 回到預設（confirmations.placeOrder=true, 非戰鬥）
    mockConfirm.mockResolvedValue(false);
    const { result } = renderHook(() => useDOMLogic(), { wrapper: wrapperWithBook });
    await act(async () => { await result.current.handleChaseOrder('Buy'); });
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockedPost).not.toHaveBeenCalled();
  });
});
