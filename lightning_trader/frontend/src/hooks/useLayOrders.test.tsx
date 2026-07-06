/**
 * useLayOrders 鋪單流程測試（Sprint C）
 *
 * 重點：
 *  1. 普通鋪單：一次總確認（列出檔數/總量/價格區間）→ 逐檔 POST /place_order
 *     （買往下鋪、tick 對齊、confirm:true）
 *  2. 追價鋪單：每檔改送 CHASE 智慧單（契約 payload），並記住回傳的智慧單 id
 *  3. 中止路徑：abortLay 後不再送出剩餘檔位
 *  4. 撤鋪單：普通單走 /cancel_all（symbol/action/price）、CHASE 走 DELETE /smart_orders/{id}
 *  5. 確認拒絕 → 完全不送單；戰鬥模式 → 總確認帶 danger 樣式
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useLayOrders } from './useLayOrders';
import {
  TradingCoreContext,
  type TradingCoreContextType,
} from '../contexts/TradingContext';
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
      put: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
    },
  };
});

// mock useConfirm：直接控制總確認結果
const { mockConfirm, mockConfirmWithInput } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockConfirmWithInput: vi.fn(),
}));
vi.mock('../contexts/ConfirmContext', () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmWithInput: mockConfirmWithInput }),
}));

import { apiClient } from '../api/client';
const mockedPost = vi.mocked(apiClient.post);
const mockedDelete = vi.mocked(apiClient.delete);

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

/** 預設參數：買 3 檔 × 2、從 99 往下、間距 1 tick（2330 → 99 / 98.9 / 98.8） */
const BASE_PARAMS = {
  side: 'Buy' as const,
  levels: 3,
  startPrice: 99,
  gapTicks: 1,
  qtyPerLevel: 2,
  useChase: false,
  orderCond: 'Cash',
  orderLot: 'Common',
};

describe('useLayOrders 鋪單', () => {
  beforeEach(() => {
    localStorage.clear();
    coreValue = makeCoreValue();
    vi.clearAllMocks();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockedPost.mockResolvedValue({ data: {} });
    mockedDelete.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('普通鋪單：總確認一次 + 逐檔 POST /place_order（買往下、tick 對齊、confirm:true）', async () => {
    const { result } = renderHook(() => useLayOrders(), { wrapper });

    let ok = false;
    await act(async () => { ok = await result.current.submitLay(BASE_PARAMS); });

    expect(ok).toBe(true);
    // 一次總確認：列出檔數 / 總量 / 價格區間
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const opts = mockConfirm.mock.calls[0][0] as ConfirmOptions;
    expect(opts.message).toContain('3 檔');
    expect(opts.message).toContain('共 6 單位');
    expect(opts.message).toContain('98.80');
    expect(opts.message).toContain('99.00');
    expect(opts.danger).toBe(false); // 非戰鬥模式

    // 逐檔送單：99 / 98.9 / 98.8，每檔 qty=2、LMT、confirm:true
    expect(mockedPost).toHaveBeenCalledTimes(3);
    const prices = mockedPost.mock.calls.map((c) => (c[1] as { price: number }).price);
    expect(prices).toEqual([99, 98.9, 98.8]);
    for (const call of mockedPost.mock.calls) {
      expect(call[0]).toBe('/place_order');
      expect(call[1]).toMatchObject({
        symbol: '2330', action: 'Buy', qty: 2,
        order_type: 'ROD', price_type: 'LMT', order_cond: 'Cash', order_lot: 'Common',
        confirm: true,
      });
    }
    expect(result.current.laidOrders).toHaveLength(3);
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });

  it('總確認拒絕 → 完全不送單', async () => {
    mockConfirm.mockResolvedValue(false);
    const { result } = renderHook(() => useLayOrders(), { wrapper });

    let ok = true;
    await act(async () => { ok = await result.current.submitLay(BASE_PARAMS); });

    expect(ok).toBe(false);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(result.current.laidOrders).toHaveLength(0);
  });

  it('戰鬥模式：總確認仍會跳，但帶 danger 樣式', async () => {
    localStorage.setItem('lightrade_settings', JSON.stringify({ isCombatMode: true }));
    const { result } = renderHook(() => useLayOrders(), { wrapper });

    await act(async () => { await result.current.submitLay(BASE_PARAMS); });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect((mockConfirm.mock.calls[0][0] as ConfirmOptions).danger).toBe(true);
    expect(mockedPost).toHaveBeenCalledTimes(3);
  });

  it('追價鋪單：每檔改送 CHASE 智慧單（契約 payload）並記住智慧單 id', async () => {
    let n = 0;
    mockedPost.mockImplementation(async () => ({ data: { id: `chase-${++n}` } }));
    const { result } = renderHook(() => useLayOrders(), { wrapper });

    await act(async () => {
      await result.current.submitLay({ ...BASE_PARAMS, side: 'Sell', levels: 2, qtyPerLevel: 1, useChase: true });
    });

    expect(mockedPost).toHaveBeenCalledTimes(2);
    for (const call of mockedPost.mock.calls) {
      expect(call[0]).toBe('/smart_orders');
      // 契約欄位完整斷言（欄位名不可改）
      expect(call[1]).toEqual({
        order_type: 'CHASE', symbol: '2330', action: 'Sell', quantity: 1,
        max_chase_ticks: 10, reprice_ticks: 1, reprice_interval_ms: 1500,
        final_action: 'GIVE_UP',
      });
    }
    expect(result.current.laidOrders).toHaveLength(2);
    expect(result.current.laidOrders.map((o) => o.smartId)).toEqual(['chase-1', 'chase-2']);
  });

  it('中止路徑：abortLay 後不再送出剩餘檔位', async () => {
    // 第一檔送出時按下「中止」→ 第二檔起不送
    mockedPost.mockImplementation(async () => {
      result.current.abortLay();
      return { data: {} };
    });
    const { result } = renderHook(() => useLayOrders(), { wrapper });

    await act(async () => { await result.current.submitLay(BASE_PARAMS); });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(result.current.laidOrders).toHaveLength(1);
  });

  it('撤鋪單（普通單）：逐檔走 /cancel_all（symbol/action/price）後清空記憶', async () => {
    const { result } = renderHook(() => useLayOrders(), { wrapper });
    await act(async () => { await result.current.submitLay({ ...BASE_PARAMS, levels: 2 }); });
    expect(result.current.laidOrders).toHaveLength(2);
    mockedPost.mockClear();

    await act(async () => { await result.current.cancelLaid(); });

    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(mockedPost.mock.calls[0]).toEqual(['/cancel_all', { symbol: '2330', action: 'Buy', price: 99 }]);
    expect(mockedPost.mock.calls[1]).toEqual(['/cancel_all', { symbol: '2330', action: 'Buy', price: 98.9 }]);
    expect(result.current.laidOrders).toHaveLength(0);
    expect(coreValue.scheduleOrderRefresh).toHaveBeenCalled();
  });

  it('撤鋪單（追價單）：走 DELETE /smart_orders/{id}', async () => {
    let n = 0;
    mockedPost.mockImplementation(async () => ({ data: { id: `chase-${++n}` } }));
    const { result } = renderHook(() => useLayOrders(), { wrapper });
    await act(async () => {
      await result.current.submitLay({ ...BASE_PARAMS, levels: 2, useChase: true });
    });
    mockedPost.mockClear();

    await act(async () => { await result.current.cancelLaid(); });

    expect(mockedPost).not.toHaveBeenCalled(); // CHASE 不走刪單 API
    expect(mockedDelete).toHaveBeenCalledTimes(2);
    expect(mockedDelete.mock.calls.map((c) => c[0])).toEqual([
      '/smart_orders/chase-1', '/smart_orders/chase-2',
    ]);
    expect(result.current.laidOrders).toHaveLength(0);
  });

  it('某檔失敗 → 停止後續送出，已送出的仍記入撤單清單', async () => {
    mockedPost
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useLayOrders(), { wrapper });

    await act(async () => { await result.current.submitLay(BASE_PARAMS); });

    expect(mockedPost).toHaveBeenCalledTimes(2); // 第 3 檔不送
    expect(result.current.laidOrders).toHaveLength(1);
  });
});
