import axios, { AxiosError } from 'axios';

export const apiClient = axios.create({
  baseURL: `http://${window.location.hostname}:8000/api`,
  timeout: 30000, // Shioaji 登入可能需要 10-15 秒
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * 標準錯誤 envelope（與後端 detail 對齊）
 *   {
 *     status: number,
 *     code:   string,        // 例如 RISK_BLOCK, MISSING_CREDENTIALS
 *     user_msg: string,      // 使用者可讀
 *     level?: 'block' | 'warning',
 *     raw:    AxiosError,
 *   }
 */
export interface LighTradeApiError {
  status: number;
  code: string;
  user_msg: string;
  level?: 'block' | 'warning';
  raw?: AxiosError;
}

export function normalizeApiError(err: unknown): LighTradeApiError {
  const ax = err as AxiosError<{ detail?: unknown }>;
  if (!ax?.response) {
    return {
      status: 0,
      code: 'NETWORK',
      user_msg: '無法連線到後端，請確認後端是否啟動',
      raw: ax,
    };
  }
  const status = ax.response.status;
  const detail = ax.response.data?.detail;
  if (typeof detail === 'string') {
    return { status, code: 'UNKNOWN', user_msg: detail, raw: ax };
  }
  if (detail && typeof detail === 'object') {
    const d = detail as { code?: string; user_msg?: string; level?: 'block' | 'warning' };
    return {
      status,
      code: d.code || 'UNKNOWN',
      user_msg: d.user_msg || '操作失敗',
      level: d.level,
      raw: ax,
    };
  }
  return { status, code: 'UNKNOWN', user_msg: '操作失敗', raw: ax };
}

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
