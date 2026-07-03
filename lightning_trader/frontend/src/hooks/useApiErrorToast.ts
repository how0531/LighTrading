/**
 * useApiErrorToast — 「normalizeApiError + toast.error」樣板的共用出口
 *
 * 用法：
 *   const handleApiError = useApiErrorToast();
 *   try { ... } catch (e) { handleApiError(e, '下單失敗'); }
 */
import { useCallback } from 'react';
import { normalizeApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';

export function useApiErrorToast(): (e: unknown, fallback: string) => void {
  const { toast } = useToast();
  return useCallback((e: unknown, fallback: string) => {
    const err = normalizeApiError(e);
    toast.error(err.user_msg || fallback);
  }, [toast]);
}
