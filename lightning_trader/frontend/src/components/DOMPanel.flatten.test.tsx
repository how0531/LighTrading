/**
 * DOMPanel — Flatten（全部平倉）熱鍵行為測試（F3）
 *
 * 重點：
 *   Flatten 熱鍵（預設 Delete）只應彈「一個」平倉確認框，並把撤單交給後端
 *   /flatten 的 cancel_pending 原子性兜底 —— 不再前端各自呼叫 handleCancelOrder
 *   （那會連帶多彈兩個刪單確認框、並對後端重複下 cancel_all）。
 *
 * 作法：mock 掉 useDOMLogic / useLayOrders 與 DOM/* 子元件，只驗證 DOMPanel 的
 * 熱鍵接線；handleFlatten 是 DOMPanel 內的真實實作（用 mock 的 confirm / apiClient）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';

// mock useConfirm：控制確認結果並計數彈框次數
const { mockConfirm, mockConfirmWithInput } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockConfirmWithInput: vi.fn(),
}));
vi.mock('../contexts/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithInput: mockConfirmWithInput }),
}));

// mock api client（保留 normalizeApiError 真實實作，供 useApiErrorToast 使用）
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

// spy：Flatten 熱鍵絕不可再呼叫 handleCancelOrder（撤單交給後端 cancel_pending）
const { handleCancelOrderSpy } = vi.hoisted(() => ({ handleCancelOrderSpy: vi.fn() }));

const DEFAULT_HOTKEYS = [
  { key: 'F1', action: 'Buy', label: '買進' },
  { key: 'F2', action: 'Sell', label: '賣出' },
  { key: 'Escape', action: 'CancelAll', label: '全刪掛單' },
  { key: 'Delete', action: 'Flatten', label: '全部平倉' },
];

function makeDomLogicStub() {
  const noop = vi.fn();
  return {
    qData: {}, bData: {},
    currentPrice: 100, refPrice: 100, limitUp: 110, limitDown: 90, highPrice: 0, lowPrice: 0,
    isSimulation: true, isStale: false, flashDir: null,
    orderValue: 1, setOrderValue: noop, orderType: 'ROD', setOrderType: noop,
    priceType: 'LMT', setPriceType: noop, orderCond: 'Cash', setOrderCond: noop,
    orderLot: 'Common', setOrderLot: noop,
    isSyncing: false, handleManualSync: noop,
    workingBuyMap: new Map(), workingSellMap: new Map(), currentPosition: null,
    handlePlaceOrder: vi.fn(), handleCancelOrder: handleCancelOrderSpy,
    handleAddStopOrder: vi.fn(), handleDropOrder: vi.fn(),
    handleChaseOrder: vi.fn(), handleMarketOrder: vi.fn(),
    chaseMode: false, setChaseMode: noop,
    orderFeedback: null, replacingOrder: null, smartOrders: [],
    splitProgress: null, abortSplit: noop,
    targetSymbol: '2330', accountSummary: {}, accounts: [], activeAccount: null, selectAccount: noop,
    hotkeys: DEFAULT_HOTKEYS, accountEquity: 0,
  };
}

vi.mock('../hooks/useDOMLogic', () => ({ useDOMLogic: () => makeDomLogicStub() }));
vi.mock('../hooks/useLayOrders', () => ({
  useLayOrders: () => ({
    layProgress: null, abortLay: vi.fn(), submitLay: vi.fn(), laidOrders: [], cancelLaid: vi.fn(),
  }),
}));

// DOM 子元件全部 render null，聚焦熱鍵接線
vi.mock('./DOM/DOMHeader', () => ({ DOMHeader: () => null }));
vi.mock('./DOM/DOMTable', () => ({ DOMTable: () => null }));
vi.mock('./DOM/DOMFooter', () => ({ DOMFooter: () => null }));
vi.mock('./DOM/DepthHeatmap', () => ({ DepthHeatmap: () => null }));
vi.mock('./DOM/LayOrdersPanel', () => ({ LayOrdersPanel: () => null }));

import { DOMPanel } from './DOMPanel';
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../contexts/ToastContext';
import { apiClient } from '../api/client';

const mockedPost = vi.mocked(apiClient.post);

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>
    <SettingsProvider>{children}</SettingsProvider>
  </ToastProvider>
);

async function pressKey(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  });
  // 熱鍵 handler 為 async（confirm → post），多刷一次 microtask/timer
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('DOMPanel Flatten 熱鍵（F3）', () => {
  beforeEach(() => {
    localStorage.clear(); // 預設：confirmations.flatten=true、非戰鬥模式
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockedPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('Flatten 只彈一個確認框，且不呼叫 handleCancelOrder', async () => {
    mockConfirm.mockResolvedValue(true);
    render(<DOMPanel />, { wrapper });

    await pressKey('Delete');

    // 只有平倉這一個確認框（不再有兩個刪單確認）
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    // 撤單交給後端 cancel_pending → 前端不再各自撤單
    expect(handleCancelOrderSpy).not.toHaveBeenCalled();
  });

  it('Flatten 確認後 → 只 POST /flatten（帶 cancel_pending:true），不另發 /cancel_all', async () => {
    mockConfirm.mockResolvedValue(true);
    render(<DOMPanel />, { wrapper });

    await pressKey('Delete');

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/flatten', { symbol: '2330', cancel_pending: true });
    const cancelAllCalls = mockedPost.mock.calls.filter((c) => c[0] === '/cancel_all');
    expect(cancelAllCalls).toHaveLength(0);
  });

  it('Flatten 確認框拒絕 → 完全不送單', async () => {
    mockConfirm.mockResolvedValue(false);
    render(<DOMPanel />, { wrapper });

    await pressKey('Delete');

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(handleCancelOrderSpy).not.toHaveBeenCalled();
  });
});
