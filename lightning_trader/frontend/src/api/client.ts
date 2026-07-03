import axios, { AxiosError } from 'axios';
import { getApiToken, resolveApiBaseUrl } from '../utils/backendUrl';

export interface LighTradeApiError {
  status: number;
  code: string;
  user_msg: string;
  level?: 'block' | 'warning';
  /** RiskManager WARNING 明細（例：市價單、價格偏離），409 CONFIRM_REQUIRED 會帶 */
  warnings?: string[];
  raw?: AxiosError;
}

interface ApiErrorDetail {
  code?: string;
  user_msg?: string;
  message?: string;
  detail?: string;
  level?: string;
  warnings?: unknown;
}

export const normalizeApiError = (err: unknown): LighTradeApiError => {
  if (axios.isAxiosError(err)) {
    const axiosError = err as AxiosError;
    const errorData = axiosError.response?.data as { detail?: ApiErrorDetail } | undefined;
    const detail: ApiErrorDetail = errorData?.detail || {};

    return {
      status: axiosError.response?.status || 500,
      code: detail.code || axiosError.code || 'UNKNOWN_ERROR',
      user_msg: detail.user_msg || detail.message || detail.detail || axiosError.message || 'API 請求發生錯誤',
      level: (detail.level === 'block' || detail.level === 'warning') ? detail.level : undefined,
      warnings: Array.isArray(detail.warnings) ? detail.warnings.map(String) : undefined,
      raw: axiosError,
    };
  }
  if (err instanceof Error) {
    return { status: 500, code: 'CLIENT_ERROR', user_msg: err.message };
  }
  return { status: 500, code: 'UNKNOWN_ERROR', user_msg: String(err) || '發生未知錯誤' };
};

export const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  timeout: 30000, // Shioaji 登入可能需要 10-15 秒
  headers: {
    'Content-Type': 'application/json',
  },
});

// 選配 API Token：後端設定 LIGHTRADE_API_TOKEN 時，所有 /api/* 請求
// （/api/health 除外）都必須帶 X-API-Token header。Token 由 SettingsModal 維護。
apiClient.interceptors.request.use((config) => {
  const token = getApiToken();
  if (token && config.url !== '/health') {
    config.headers.set('X-API-Token', token);
  }
  return config;
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
