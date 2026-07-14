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

// mock useToast：驗證刪單消費後端回傳的實際撤單數（cancelled）
const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../contexts/ToastContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../contexts/ToastContext')>();
  return { ...actual, useToast: () => ({ toast: mockToast }) };
});

// 拆單：保留真實 splitOrders，只把 randomDelay 換成可控 mock（F2 中止測試在拆單間隙觸發中止）
vi.mock('../utils/splitOrder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/splitOrder')>();
  return { ...actual, randomDelay: vi.fn(() => Promise.resolve()) };
});

// 取得 mock 後的 apiClient（vi.mock hoisting 保證這裡拿到的是 mock）
import { apiClient } from '../api/client';
import { randomDelay } from '../utils/splitOrder';
const mockedPost = vi.mocked(apiClient.post);
const mockedRandomDelay = vi.mocked(randomDelay);

const quoteStub: QuoteData = {
  Symbol: '2330', Price: 100, Volume: 1, Reference: 100,
  TickTime: '09:00:00', Action: '',
};

const quotesValue: QuotesContextType = {
  quote: quoteStub,
  bidAsk: null,
  quoteHistory: [],
  watchlistQuotes: {},
  bidAskBySymbol: {},
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

  it('刪單：POST /cancel_all 帶 symbol/action/price，且消費後端回傳的實際撤單數', async () => {
    // 後端精確價位撤單回傳 cancelled=2 → toast 應反映實際撤單數（非「一律 200 當成功」）
    mockedPost.mockResolvedValueOnce({ data: { cancelled: 2 } });
    const { result } = renderHook(() => useDOMLogic(), { wrapper });

    await act(async () => {
      await result.current.handleCancelOrder('Sell', 101.5);
    });

    expect(mockedPost).toHaveBeenCalledWith('/cancel_all', { symbol: '2330', action: 'Sell', price: 101.5 });
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('2'));
  });

  it('刪單：指定價位撤到 0 筆（單已不在）→ 據實回報，不當成功', async () => {
    mockedPost.mockResolvedValueOnce({ data: { cancelled: 0 } });
    const { result } = renderHook(() => useDOMLogic(), { wrapper });

    await act(async () => {
      await result.current.handleCancelOrder('Sell', 101.5);
    });

    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith(expect.stringContaining('無'));
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

  it('C3：確認框接受 → 送單但首發不帶 confirm（一般確認框不授權跳過後端 WARNING）', async () => {
    mockConfirm.mockResolvedValue(true);
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });
    // 只彈一次一般下單確認框；後端無 WARNING（回 200）→ 單發、且 payload 不含 confirm:true
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/place_order', EXPECTED_LIMIT_PAYLOAD);
    expect(mockedPost.mock.calls[0][1]).not.toHaveProperty('confirm');
  });

  it('C3：一般確認接受後仍遇 409 → 再彈含全文的 danger 框授權，帶 confirm:true 重送', async () => {
    mockedPost
      .mockRejectedValueOnce(confirmRequiredError())
      .mockResolvedValueOnce({ data: {} });
    mockConfirm.mockResolvedValue(true); // 一般框 + danger 框皆接受

    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });

    // 兩個確認框：先一般下單確認、後風控 danger（含 user_msg + warnings 全文）
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    const generalOpts = mockConfirm.mock.calls[0][0] as ConfirmOptions;
    expect(generalOpts.title).toBe('下單確認');
    const dangerOpts = mockConfirm.mock.calls[1][0] as ConfirmOptions;
    expect(dangerOpts.danger).toBe(true);
    expect(dangerOpts.message).toContain('此單需要確認');
    expect(dangerOpts.message).toContain('市價單風險');
    expect(dangerOpts.message).toContain('價格偏離參考價 3%');

    // 首發不帶 confirm → 觸發後端 409；danger 授權後帶 confirm:true 重送
    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(mockedPost.mock.calls[0]).toEqual(['/place_order', EXPECTED_LIMIT_PAYLOAD]);
    expect(mockedPost.mock.calls[1]).toEqual(['/place_order', { ...EXPECTED_LIMIT_PAYLOAD, confirm: true }]);
  });

  it('C3：一般確認接受後遇 409、danger 框拒絕 → 不重送', async () => {
    mockedPost.mockRejectedValueOnce(confirmRequiredError());
    // 第一個(一般框) 接受、第二個(danger 框) 拒絕
    mockConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });

    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(mockedPost).toHaveBeenCalledTimes(1); // 僅首發，未重送
    expect(coreValue.scheduleOrderRefresh).not.toHaveBeenCalled();
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

// ─── Sprint C：DOM 追價模式（CHASE 智慧單） ────────────────
// toggle 開啟後 ladder 點價 / 追買追賣熱鍵改送 CHASE；市價熱鍵與刪單不受影響。

/** 後端 CHASE 契約 payload（欄位名不可改） */
const EXPECTED_CHASE_PAYLOAD = {
  order_type: 'CHASE',
  symbol: '2330',
  action: 'Buy',
  quantity: 1,
  max_chase_ticks: 10,
  reprice_ticks: 1,
  reprice_interval_ms: 1500,
  final_action: 'GIVE_UP',
};

describe('useDOMLogic 追價模式（CHASE 智慧單）', () => {
  beforeEach(() => {
    localStorage.clear();
    // 戰鬥模式：跳過前端確認，聚焦驗證 payload 路由
    localStorage.setItem('lightrade_settings', JSON.stringify({ isCombatMode: true }));
    coreValue = makeCoreValue();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockedPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('追價模式開啟：ladder 點價改送 CHASE 智慧單（契約欄位完整斷言）', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    act(() => { result.current.setChaseMode(true); });
    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/smart_orders', EXPECTED_CHASE_PAYLOAD);
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });

  it('追價參數取自 settings.chase：max_chase_ticks / final_action 反映設定值', async () => {
    localStorage.setItem('lightrade_settings', JSON.stringify({
      isCombatMode: true,
      chase: { maxChaseTicks: 5, finalAction: 'MARKET' },
    }));
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    act(() => { result.current.setChaseMode(true); });
    await act(async () => { await result.current.handlePlaceOrder(100, 'Sell'); });

    expect(mockedPost).toHaveBeenCalledWith('/smart_orders', {
      ...EXPECTED_CHASE_PAYLOAD, action: 'Sell', max_chase_ticks: 5, final_action: 'MARKET',
    });
  });

  it('追價模式關閉（預設）：照送普通 /place_order，payload 不變', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    expect(result.current.chaseMode).toBe(false);
    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/place_order', EXPECTED_LIMIT_PAYLOAD);
  });

  it('追價模式開啟：ChaseBuy 熱鍵（handleChaseOrder）也改送 CHASE', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper: wrapperWithBook });
    act(() => { result.current.setChaseMode(true); });
    await act(async () => { await result.current.handleChaseOrder('Buy'); });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost.mock.calls[0][0]).toBe('/smart_orders');
    expect(mockedPost.mock.calls[0][1]).toMatchObject({
      order_type: 'CHASE', action: 'Buy', quantity: 1,
    });
  });

  it('追價模式開啟：市價熱鍵不受影響（照送 /place_order + MKT）', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper: wrapperWithBook });
    act(() => { result.current.setChaseMode(true); });
    await act(async () => { await result.current.handleMarketOrder('Sell'); });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/place_order',
      expect.objectContaining({ price: 0, action: 'Sell', price_type: 'MKT' }));
  });

  it('追價模式開啟：刪單不受影響（照走 /cancel_all）', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    act(() => { result.current.setChaseMode(true); });
    await act(async () => { await result.current.handleCancelOrder('Buy', 99.5); });

    expect(mockedPost).toHaveBeenCalledWith('/cancel_all',
      { symbol: '2330', action: 'Buy', price: 99.5 });
  });

  it('非戰鬥模式：追價單走確認流且文案標明「追價」；拒絕 → 不送單', async () => {
    localStorage.clear(); // 預設：confirmations.placeOrder=true、非戰鬥
    mockConfirm.mockResolvedValue(false);
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    act(() => { result.current.setChaseMode(true); });
    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const opts = mockConfirm.mock.calls[0][0] as ConfirmOptions;
    expect(`${opts.title ?? ''} ${opts.message}`).toContain('追價');
    expect(mockedPost).not.toHaveBeenCalled();
  });
});

// ─── F2：拆單中止時不播「成功」回饋 ────────────────
describe('useDOMLogic 拆單中止（F2）', () => {
  beforeEach(() => {
    localStorage.clear();
    // 戰鬥模式（跳過前端確認）+ 開啟拆單，門檻低到必拆、每批 1 口 → orderValue=3 拆成 3 批
    localStorage.setItem('lightrade_settings', JSON.stringify({
      isCombatMode: true,
      splitOrder: { enabled: true, threshold: 1, minPerLot: 1, maxPerLot: 1, minDelay: 0, maxDelay: 0 },
    }));
    coreValue = makeCoreValue();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockedPost.mockResolvedValue({ data: {} });
    mockedRandomDelay.mockReset();
    mockedRandomDelay.mockResolvedValue(undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('拆單送出第一批後中止 → 只留「已中止」提示，不播成功回饋（成功 toast / 綠閃）', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    act(() => { result.current.setOrderValue(3); });
    // 第一批送出後、進第二批前會 await randomDelay → 於此時觸發中止
    mockedRandomDelay.mockImplementation(async () => { result.current.abortSplit(); });

    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });

    // 只送出第一批（中止後不再連發）
    expect(mockedPost).toHaveBeenCalledTimes(1);
    // 中止提示有、成功 toast 無
    expect(mockToast.info).toHaveBeenCalledWith(expect.stringContaining('已中止'));
    expect(mockToast.success).not.toHaveBeenCalled();
    // 中止不留下成功綠閃（pending 已清）
    expect(result.current.orderFeedback).toBeNull();
    // 真實已下單 → 仍對帳
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });

  it('拆單全部送完（未中止）→ 照播成功回饋', async () => {
    const { result } = renderHook(() => useDOMLogic(), { wrapper });
    act(() => { result.current.setOrderValue(3); });

    await act(async () => { await result.current.handlePlaceOrder(100, 'Buy'); });

    expect(mockedPost).toHaveBeenCalledTimes(3);
    expect(mockToast.success).toHaveBeenCalled();
    expect(mockToast.info).not.toHaveBeenCalledWith(expect.stringContaining('已中止'));
  });
});
