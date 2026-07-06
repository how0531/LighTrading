/**
 * ConfirmContext / ConfirmDialog 測試（UX 批次 3）
 *
 * 覆蓋：
 *  1. confirm() 點「確認」→ resolve true、對話框關閉
 *  2. confirm() 點「取消」→ resolve false
 *  3. Esc → resolve false；Enter → resolve true
 *  4. backdrop 點擊 → resolve false
 *  5. 併發請求排隊：一次只顯示一個，resolve 後顯示下一個
 *  6. confirmWithInput()：確認回傳輸入值、取消回傳 null、validate 擋下無效輸入
 */
import { describe, it, expect } from 'vitest';
import React, { useEffect } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ConfirmProvider, useConfirm, type ConfirmApi } from './ConfirmContext';

const ApiCapture: React.FC<{ apiRef: { current: ConfirmApi | null } }> = ({ apiRef }) => {
  const api = useConfirm();
  // render() 內部包 act，effect 會同步 flush → setup() 回傳前 apiRef 已就緒
  useEffect(() => { apiRef.current = api; }, [apiRef, api]);
  return null;
};

function setup() {
  const apiRef: { current: ConfirmApi | null } = { current: null };
  render(
    <ConfirmProvider>
      <ApiCapture apiRef={apiRef} />
    </ConfirmProvider>,
  );
  return apiRef as { current: ConfirmApi };
}

describe('ConfirmContext — confirm()', () => {
  it('點「確認」→ resolve true，對話框關閉', async () => {
    const api = setup();
    let p!: Promise<boolean>;
    act(() => { p = api.current.confirm({ title: '下單確認', message: '確認買進 2330？' }); });

    expect(await screen.findByText('確認買進 2330？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '確認' }));

    await expect(p).resolves.toBe(true);
    await waitFor(() => {
      expect(screen.queryByText('確認買進 2330？')).not.toBeInTheDocument();
    });
  });

  it('點「取消」→ resolve false', async () => {
    const api = setup();
    let p!: Promise<boolean>;
    act(() => { p = api.current.confirm({ title: '刪單確認', message: '確認刪除掛單？' }); });

    expect(await screen.findByText('確認刪除掛單？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await expect(p).resolves.toBe(false);
  });

  it('Esc → resolve false', async () => {
    const api = setup();
    let p!: Promise<boolean>;
    act(() => { p = api.current.confirm({ title: '確認', message: 'Esc 取消測試' }); });

    expect(await screen.findByText('Esc 取消測試')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    await expect(p).resolves.toBe(false);
  });

  it('Enter → resolve true', async () => {
    const api = setup();
    let p!: Promise<boolean>;
    act(() => { p = api.current.confirm({ title: '確認', message: 'Enter 確認測試' }); });

    expect(await screen.findByText('Enter 確認測試')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Enter' });

    await expect(p).resolves.toBe(true);
  });

  it('backdrop 點擊 → resolve false', async () => {
    const api = setup();
    let p!: Promise<boolean>;
    act(() => { p = api.current.confirm({ title: '確認', message: 'backdrop 測試' }); });

    expect(await screen.findByText('backdrop 測試')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('presentation'));

    await expect(p).resolves.toBe(false);
  });

  it('danger 選項 → 自訂 confirmLabel 出現（風控警告樣式路徑）', async () => {
    const api = setup();
    let p!: Promise<boolean>;
    act(() => {
      p = api.current.confirm({
        title: '風控警告', message: '市價單風險', danger: true, confirmLabel: '確認送單',
      });
    });

    expect(await screen.findByText('市價單風險')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '確認送單' }));
    await expect(p).resolves.toBe(true);
  });

  it('併發請求排隊：一次只顯示一個，resolve 後顯示下一個', async () => {
    const api = setup();
    let p1!: Promise<boolean>;
    let p2!: Promise<boolean>;
    act(() => {
      p1 = api.current.confirm({ title: '刪單確認', message: '刪除買方掛單？' });
      p2 = api.current.confirm({ title: '刪單確認', message: '刪除賣方掛單？' });
    });

    // 只顯示第一個
    expect(await screen.findByText('刪除買方掛單？')).toBeInTheDocument();
    expect(screen.queryByText('刪除賣方掛單？')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '確認' }));
    await expect(p1).resolves.toBe(true);

    // 第二個接著出現
    expect(await screen.findByText('刪除賣方掛單？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await expect(p2).resolves.toBe(false);
  });
});

describe('ConfirmContext — confirmWithInput()', () => {
  it('修改輸入後確認 → resolve 輸入值', async () => {
    const api = setup();
    let p!: Promise<string | null>;
    act(() => {
      p = api.current.confirmWithInput({
        title: '委託減量', message: '輸入新的總委託數量', defaultValue: '5',
      });
    });

    const input = await screen.findByRole('textbox');
    expect(input).toHaveValue('5');
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '確認' }));

    await expect(p).resolves.toBe('3');
  });

  it('Esc 取消 → resolve null', async () => {
    const api = setup();
    let p!: Promise<string | null>;
    act(() => {
      p = api.current.confirmWithInput({
        title: '委託減量', message: '輸入數量', defaultValue: '5',
      });
    });

    await screen.findByRole('textbox');
    fireEvent.keyDown(window, { key: 'Escape' });

    await expect(p).resolves.toBeNull();
  });

  it('validate 失敗 → 顯示錯誤、不 resolve；修正後可確認', async () => {
    const api = setup();
    let p!: Promise<string | null>;
    act(() => {
      p = api.current.confirmWithInput({
        title: '委託減量', message: '輸入數量', defaultValue: '9',
        validate: (v) => (parseInt(v, 10) < 5 ? null : '必須 < 5'),
      });
    });

    const input = await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: '確認' }));

    // 錯誤訊息出現、對話框仍在
    expect(await screen.findByText('必須 < 5')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '確認' }));
    await expect(p).resolves.toBe('2');
  });
});
