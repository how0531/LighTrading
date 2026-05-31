import axios, { AxiosError } from 'axios';

// 一律走相對路徑 /api。
//   - dev：vite proxy 轉到 127.0.0.1:8000
//   - prod / docker：nginx 同站台 proxy 轉到 backend
// 這樣切換部署模式不用改前端程式碼。
export const apiClient = axios.create({
  baseURL: '/api',
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

// ─── Trader 進階工具 ──────────────────────────────────────

export interface CalcQtyRequest {
  symbol: string;
  risk_amount: number;
  entry_price: number;
  stop_price: number;
  max_qty?: number;
}

export interface CalcQtyResult {
  qty: number;
  actual_risk: number;
  risk_per_qty: number;
  distance: number;
  multiplier: number;
  warnings: string[];
}

export const calcQty = async (req: CalcQtyRequest): Promise<CalcQtyResult> => {
  const r = await apiClient.post('/calc_qty', req);
  return r.data;
};

export interface VWAPSnapshot {
  symbol: string;
  vwap: number | null;
  total_volume: number;
  tick_count: number;
}

export const getVWAP = async (symbol: string): Promise<VWAPSnapshot> => {
  const r = await apiClient.get(`/vwap/${encodeURIComponent(symbol)}`);
  return r.data;
};

export interface TapeRow {
  time: string;
  price: number;
  volume: number;
  tick_type: number; // 1=外盤 2=內盤
}

export const getTape = async (symbol: string, limit = 100): Promise<{ rows: TapeRow[] }> => {
  const r = await apiClient.get(`/tape/${encodeURIComponent(symbol)}`, { params: { limit } });
  return r.data;
};

export const addOCO = async (p: {
  symbol: string; action: 'Buy' | 'Sell'; qty: number;
  take_profit: number; stop_loss: number;
}) => (await apiClient.post('/add_oco', p)).data;

export const addBracket = async (p: {
  symbol: string; action: 'Buy' | 'Sell'; qty: number;
  entry_price: number; take_profit: number; stop_loss: number;
}) => (await apiClient.post('/add_bracket', p)).data;

export const addScaleOut = async (p: {
  symbol: string; action: 'Buy' | 'Sell';
  targets: { price: number; qty: number }[];
  stop_loss: number; runner_trailing?: number;
}) => (await apiClient.post('/add_scale_out', p)).data;

// ─── 音效設定 ───────────────────────────────────────────

export interface SoundStatus {
  muted: boolean;
  volume: number;
  available_sounds: string[];
  unmutable_sounds: string[];
}

export const getSoundStatus = async (): Promise<SoundStatus> =>
  (await apiClient.get('/sound/status')).data;

export const setSoundConfig = async (p: { muted?: boolean; volume?: number }) =>
  (await apiClient.put('/sound/config', p)).data;

export const testSound = async (event: string) =>
  (await apiClient.post('/sound/test', { event })).data;
