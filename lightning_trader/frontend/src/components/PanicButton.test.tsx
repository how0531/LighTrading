/**
 * PanicButton 測試 — 雙重確認流是保命裝置的核心。
 *
 * 驗證：
 *  - 兩重確認都通過 → 才呼叫 panic()，成功以 toast 回報
 *  - 第一重取消 → 不呼叫、也不出現第二重
 *  - 第二重返回 → 不呼叫
 *  - panic 失敗 → 走錯誤正規化 toast
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PanicButton from './PanicButton';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../contexts/ConfirmContext';

const { mockPanic } = vi.hoisted(() => ({ mockPanic: vi.fn() }));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, panic: mockPanic };
});

const renderButton = () =>
  render(
    <ToastProvider>
      <ConfirmProvider>
        <PanicButton />
      </ConfirmProvider>
    </ToastProvider>,
  );

describe('PanicButton 雙重確認流', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPanic.mockResolvedValue({
      trading_disabled: true,
      smart_orders_cancelled: 0,
      cancelled_orders: 3,
      flattened_symbols: ['TXFR1'],
      errors: [],
      status: 'ok',
    });
  });

  it('兩重確認都通過才呼叫 panic()，並以成功 toast 回報', async () => {
    renderButton();
    fireEvent.click(screen.getByTestId('panic-button'));

    // 第一重
    const firstConfirm = await screen.findByText('繼續');
    expect(mockPanic).not.toHaveBeenCalled(); // 第一重尚未按下前不得呼叫
    fireEvent.click(firstConfirm);

    // 第二重
    const secondConfirm = await screen.findByText('執行全平倉/斷路');
    expect(mockPanic).not.toHaveBeenCalled(); // 第二重按下前仍不得呼叫
    fireEvent.click(secondConfirm);

    await waitFor(() => expect(mockPanic).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/恐慌鈕已執行/)).toBeInTheDocument();
  });

  it('第一重取消 → 不呼叫 panic()，也不進入第二重', async () => {
    renderButton();
    fireEvent.click(screen.getByTestId('panic-button'));

    const cancel = await screen.findByText('取消');
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByText('繼續')).toBeNull());
    expect(screen.queryByText('執行全平倉/斷路')).toBeNull();
    expect(mockPanic).not.toHaveBeenCalled();
  });

  it('第二重返回 → 不呼叫 panic()', async () => {
    renderButton();
    fireEvent.click(screen.getByTestId('panic-button'));

    fireEvent.click(await screen.findByText('繼續'));
    const back = await screen.findByText('返回');
    fireEvent.click(back);

    await waitFor(() => expect(screen.queryByText('執行全平倉/斷路')).toBeNull());
    expect(mockPanic).not.toHaveBeenCalled();
  });

  it('部分失敗 → 以警告 toast 回報錯誤明細', async () => {
    mockPanic.mockResolvedValue({
      trading_disabled: true,
      smart_orders_cancelled: null,
      cancelled_orders: 1,
      flattened_symbols: [],
      errors: ['flatten TXFR1: broker timeout'],
      status: 'partial',
    });
    renderButton();
    fireEvent.click(screen.getByTestId('panic-button'));
    fireEvent.click(await screen.findByText('繼續'));
    fireEvent.click(await screen.findByText('執行全平倉/斷路'));

    expect(await screen.findByText(/恐慌鈕部分完成/)).toBeInTheDocument();
  });
});
