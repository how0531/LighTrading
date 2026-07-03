/* eslint-disable react-refresh/only-export-components --
 * Context Provider 與 hook 需同檔共享；改動本檔會整頁 HMR reload，可接受 */
/**
 * ToastContext — 全域訊息中心
 *
 * 取代所有 alert / window.confirm / console.error，作為「Action 結果」與
 * 「可操作錯誤」的單一出口。Toast 自動 5 秒消失（error 8 秒），可手動關閉。
 *
 * 使用：
 *   const { toast } = useToast();
 *   toast.success('委託送出');
 *   toast.error('保證金不足');
 *   toast.warn('部位上限警告', { actionLabel: '繼續', onAction: doIt });
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

export type ToastLevel = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: number;
  level: ToastLevel;
  message: string;
  timestamp: number;
  durationMs: number;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastOptions {
  durationMs?: number;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastApi {
  success: (msg: string, opts?: ToastOptions) => number;
  error:   (msg: string, opts?: ToastOptions) => number;
  warn:    (msg: string, opts?: ToastOptions) => number;
  info:    (msg: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
  clear:   () => void;
}

interface ToastContextType {
  toast: ToastApi;
  toasts: ToastItem[];
}

const ToastContext = createContext<ToastContextType | null>(null);

const DEFAULT_DURATION: Record<ToastLevel, number> = {
  success: 4000,
  info:    4000,
  warning: 6000,
  error:   8000,
};

let _seq = 0;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastsRef = useRef<ToastItem[]>([]);
  useEffect(() => { toastsRef.current = toasts; }, [toasts]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((level: ToastLevel, message: string, opts: ToastOptions = {}): number => {
    _seq += 1;
    const id = _seq;
    const duration = opts.durationMs ?? DEFAULT_DURATION[level];
    const item: ToastItem = {
      id, level, message,
      timestamp: Date.now(),
      durationMs: duration,
      actionLabel: opts.actionLabel,
      onAction: opts.onAction,
    };
    setToasts((prev) => [...prev.slice(-4), item]); // 最多疊 5 個
    if (duration > 0) {
      window.setTimeout(() => dismiss(id), duration);
    }
    return id;
  }, [dismiss]);

  const toast: ToastApi = useMemo(() => ({
    success: (msg, opts) => push('success', msg, opts),
    error:   (msg, opts) => push('error',   msg, opts),
    warn:    (msg, opts) => push('warning', msg, opts),
    info:    (msg, opts) => push('info',    msg, opts),
    dismiss,
    clear:   () => setToasts([]),
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={{ toast, toasts }}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
};

// ─── Viewport ─────────────────────────────────────────────

const LEVEL_STYLES: Record<ToastLevel, { ring: string; bg: string; text: string; Icon: React.ComponentType<{ className?: string }> }> = {
  success: { ring: 'border-emerald-500/50',  bg: 'bg-emerald-900/30',  text: 'text-emerald-200',  Icon: CheckCircle2 },
  error:   { ring: 'border-red-500/60',      bg: 'bg-red-950/40',      text: 'text-red-200',      Icon: XCircle },
  warning: { ring: 'border-amber-500/60',    bg: 'bg-amber-950/30',    text: 'text-amber-200',    Icon: AlertTriangle },
  info:    { ring: 'border-slate-500/50',    bg: 'bg-slate-800/50',    text: 'text-slate-200',    Icon: Info },
};

const ToastViewport: React.FC<{ toasts: ToastItem[]; dismiss: (id: number) => void }> = ({ toasts, dismiss }) => {
  return (
    <div className="fixed top-4 right-4 z-[200] flex flex-col gap-2 max-w-md pointer-events-none">
      {toasts.map((t) => {
        const s = LEVEL_STYLES[t.level];
        const Icon = s.Icon;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 ${s.bg} backdrop-blur-md ${s.text} border ${s.ring} rounded-lg px-4 py-3 shadow-2xl animate-[slideInRight_0.2s_ease-out] tabular-nums`}
            role="status"
          >
            <Icon className="w-5 h-5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-snug whitespace-pre-line break-words">{t.message}</p>
              {t.actionLabel && t.onAction && (
                <button
                  onClick={() => { t.onAction?.(); dismiss(t.id); }}
                  className="mt-2 px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs font-bold transition-colors"
                >
                  {t.actionLabel}
                </button>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="p-1 rounded hover:bg-white/10 text-slate-300 hover:text-white transition-colors"
              aria-label="dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
