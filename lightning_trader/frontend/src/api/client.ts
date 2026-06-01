import axios, { AxiosError } from 'axios';

export interface LighTradeApiError {
  status: number;
  code: string;
  user_msg: string;
  level?: 'block' | 'warning';
  raw?: AxiosError;
}

export const normalizeApiError = (err: unknown): LighTradeApiError => {
  if (axios.isAxiosError(err)) {
    const axiosError = err as AxiosError;
    const errorData = axiosError.response?.data as any;
    const detail = errorData?.detail || {};
    
    return {
      status: axiosError.response?.status || 500,
      code: detail.code || axiosError.code || 'UNKNOWN_ERROR',
      user_msg: detail.user_msg || detail.message || detail.detail || axiosError.message || 'API 請求發生錯誤',
      level: (detail.level === 'block' || detail.level === 'warning') ? detail.level : undefined,
      raw: axiosError,
    };
  }
  if (err instanceof Error) {
    return { status: 500, code: 'CLIENT_ERROR', user_msg: err.message };
  }
  return { status: 500, code: 'UNKNOWN_ERROR', user_msg: String(err) || '發生未知錯誤' };
};

// Electron packaged build 跑 file:// 協議時，window.location.hostname 會是空字串，
// 導致 baseURL 組成 "http://:8000/api" 這種無效 URL。
// 固定指向 127.0.0.1；Electron 與瀏覽器 dev 都走本機 backend。
const BACKEND_HOST =
  window.location.protocol === 'file:' || !window.location.hostname
    ? '127.0.0.1'
    : window.location.hostname;

export const apiClient = axios.create({
  baseURL: `http://${BACKEND_HOST}:8000/api`,
  timeout: 30000, // Shioaji 登入可能需要 10-15 秒
  headers: {
    'Content-Type': 'application/json',
  },
});

export const getPositions = async (accountId?: string) => {
  const response = await apiClient.get('/positions', { params: { account_id: accountId } });
  return response.data;
};

export const getAccountBalance = async () => {
  const response = await apiClient.get('/account_balance');
  return response.data;
};

export const getOrderHistory = async (accountId?: string) => {
  const response = await apiClient.get('/order_history', { params: { account_id: accountId } });
  return response.data;
};

export const getAccounts = async () => {
  const response = await apiClient.get('/accounts');
  return response.data;
};
