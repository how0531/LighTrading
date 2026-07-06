/* eslint-disable react-refresh/only-export-components --
 * Context Provider 與 hook 需同檔共享；改動本檔會整頁 HMR reload，可接受 */
/**
 * ConfirmContext — Promise-based 確認對話框（UX 批次 3）
 *
 * 取代所有 window.confirm / window.prompt：
 *   const { confirm, confirmWithInput } = useConfirm();
 *   const ok = await confirm({ title: '下單確認', message: '...' });
 *   const val = await confirmWithInput({ title: '減量', message: '...', defaultValue: '3' });
 *
 * 特性：
 *  - Promise-based，不阻塞 UI thread（報價/推播照常更新）
 *  - 併發請求排隊（例：CancelAll 熱鍵同時觸發買/賣兩次刪單確認）
 *  - Enter=確認、Esc=取消、backdrop 點擊=取消、autoFocus 確認鈕
 *  - 對話框開啟時攔截 window keydown（capture），避免誤觸 DOM 快捷鍵
 *  - danger 樣式：風控警告 / 平倉 / 反手等破壞性操作用紅色確認鈕
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface ConfirmInputOptions {
  title: string;
  message: string;
  defaultValue: string;
  /** 回傳錯誤訊息（string）代表不合法、擋下確認；回 null 代表通過 */
  validate?: (value: string) => string | null;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface ConfirmApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  confirmWithInput: (opts: ConfirmInputOptions) => Promise<string | null>;
}

type ConfirmRequest =
  | { id: number; kind: 'confirm'; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { id: number; kind: 'input'; opts: ConfirmInputOptions; resolve: (value: string | null) => void };

const ConfirmContext = createContext<ConfirmApi | null>(null);

let _seq = 0;

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 佇列：一次只顯示第一個，resolve 後 shift 出下一個
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const current = queue[0] ?? null;

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      _seq += 1;
      setQueue((q) => [...q, { id: _seq, kind: 'confirm', opts, resolve }]);
    });
  }, []);

  const confirmWithInput = useCallback((opts: ConfirmInputOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      _seq += 1;
      setQueue((q) => [...q, { id: _seq, kind: 'input', opts, resolve }]);
    });
  }, []);

  const settle = useCallback((req: ConfirmRequest, value: boolean | string | null) => {
    setQueue((q) => q.filter((r) => r.id !== req.id));
    if (req.kind === 'confirm') req.resolve(value === true);
    else req.resolve(typeof value === 'string' ? value : null);
  }, []);

  const api = useMemo<ConfirmApi>(() => ({ confirm, confirmWithInput }), [confirm, confirmWithInput]);

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      {current && <ConfirmDialog key={current.id} request={current} settle={settle} />}
    </ConfirmContext.Provider>
  );
};

export const useConfirm = (): ConfirmApi => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
};

// ─── Dialog ───────────────────────────────────────────────

const ConfirmDialog: React.FC<{
  request: ConfirmRequest;
  settle: (req: ConfirmRequest, value: boolean | string | null) => void;
}> = ({ request, settle }) => {
  const { opts } = request;
  const danger = opts.danger ?? false;
  const isInput = request.kind === 'input';
  const [inputValue, setInputValue] = useState(isInput ? (request.opts as ConfirmInputOptions).defaultValue : '');
  const [inputError, setInputError] = useState<string | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleCancel = useCallback(() => {
    settle(request, isInput ? null : false);
  }, [settle, request, isInput]);

  const handleConfirm = useCallback(() => {
    if (isInput) {
      const validate = (request.opts as ConfirmInputOptions).validate;
      const err = validate ? validate(inputValue) : null;
      if (err) {
        setInputError(err);
        inputRef.current?.focus();
        return;
      }
      settle(request, inputValue);
    } else {
      settle(request, true);
    }
  }, [isInput, request, inputValue, settle]);

  // autoFocus：input 模式聚焦輸入框（全選），否則聚焦確認鈕
  useEffect(() => {
    if (isInput) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      confirmBtnRef.current?.focus();
    }
  }, [isInput]);

  // Enter=確認 / Esc=取消。capture-phase 攔截，對話框開啟時吞掉所有
  // window keydown（DOMPanel 的全域下單快捷鍵不能在 modal 開啟時觸發）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleConfirm, handleCancel]);

  const Icon = danger ? AlertTriangle : HelpCircle;

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onMouseDown={handleCancel}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={opts.title}
        className={`relative w-full max-w-sm bg-[#1C2331] border rounded-xl shadow-2xl shadow-black/50 overflow-hidden ${
          danger ? 'border-red-800/70' : 'border-[#29344A]'
        }`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-3 flex items-start gap-3">
          <div className={`mt-0.5 p-1.5 rounded-lg shrink-0 ${danger ? 'bg-red-950/60 text-red-400' : 'bg-slate-800 text-[#D4AF37]'}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className={`text-sm font-black tracking-wide ${danger ? 'text-red-300' : 'text-slate-100'}`}>
              {opts.title}
            </h3>
            <p className="mt-1 text-xs text-slate-300 leading-relaxed whitespace-pre-line break-words">
              {opts.message}
            </p>
            {isInput && (
              <div className="mt-3">
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => { setInputValue(e.target.value); setInputError(null); }}
                  className={`w-full bg-[#101623] border rounded px-2 py-1.5 text-sm font-mono tabular-nums text-slate-100 outline-none focus:ring-1 ${
                    inputError
                      ? 'border-red-500/70 focus:ring-red-500'
                      : 'border-slate-700 focus:border-slate-500 focus:ring-slate-500'
                  }`}
                  aria-label={opts.title}
                />
                {inputError && (
                  <p className="mt-1 text-[11px] text-red-400 font-medium">{inputError}</p>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="px-4 py-3 bg-[#151b26] border-t border-slate-800 flex justify-end gap-2">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 rounded text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
          >
            {opts.cancelLabel ?? '取消'}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={handleConfirm}
            className={`px-3 py-1.5 rounded text-xs font-black transition-colors cursor-pointer border focus:outline-none focus:ring-2 ${
              danger
                ? 'bg-red-600 hover:bg-red-500 text-white border-red-500/60 focus:ring-red-400/60'
                : 'bg-[#D4AF37] hover:bg-[#e0c159] text-[#101623] border-[#D4AF37]/60 focus:ring-[#D4AF37]/60'
            }`}
          >
            {opts.confirmLabel ?? '確認'}
          </button>
        </div>
      </div>
    </div>
  );
};
