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
    const errorData = axiosError.response?.data as { detail?: ApiErrorDetail | string } | undefined;

    // 部分後端 endpoint 直接 raise HTTPException(detail="訊息字串")：
    // detail 是純字串而非結構化物件，直接把它當 user_msg 呈現
    if (typeof errorData?.detail === 'string') {
      return {
        status: axiosError.response?.status || 500,
        code: 'API_ERROR',
        user_msg: errorData.detail,
        raw: axiosError,
      };
    }

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

// ─── 執行期安全網（backend/routers/safety.py）───────────────────────────────

/** POST /api/panic 各步結果（各步 best-effort，errors 逐項回報） */
export interface PanicResult {
  /** 是否成功把 trading_enabled 翻成 false（停用一切新單） */
  trading_disabled: boolean;
  /** 撤掉的智慧單數；後端無智慧單引擎時為 null */
  smart_orders_cancelled: number | null;
  /** 雙側全撤掉的委託總筆數 */
  cancelled_orders: number;
  /** 成功送出平倉的商品代碼 */
  flattened_symbols: string[];
  /** 逐步錯誤（空陣列＝全成） */
  errors: string[];
  /** 'ok'＝零錯誤；'partial'＝部分步驟失敗 */
  status: 'ok' | 'partial';
}

/** GET /api/safety/health 的 risk 區塊（risk_manager 不可用時整塊為 null） */
export interface SafetyHealthRisk {
  /** 熔斷中＝交易被停用（日虧損 / 硬上限 / 速率凍結 / 恐慌鈕任一） */
  halted: boolean;
  trading_enabled: boolean;
  daily_total_pnl: number;
  max_daily_loss: number;
  daily_order_count: number;
  max_orders_per_day: number;
  daily_notional: number;
  max_notional_per_day: number;
  panic_rate: number;
}

/** 最近一次對帳落差（尚無資料時整塊為 null） */
export interface SafetyReconciliation {
  available: boolean;
  computed: number | null;
  broker_reported: number | null;
  delta: number | null;
  within_threshold?: boolean;
  threshold: number | null;
  ts: number;
}

export interface SafetyConnection {
  shioaji_connected: boolean;
  ws_clients: number;
}

export interface SafetyHealth {
  status: string;
  risk: SafetyHealthRisk | null;
  invariant_enforce: boolean;
  last_reconciliation: SafetyReconciliation | null;
  connection: SafetyConnection;
}

/**
 * 恐慌鈕：一鍵停用交易 + 撤所有委託（含智慧單，雙側）+ 平所有持倉。
 * 走 apiClient → 帶 X-API-Token；回各步結果供 UI 回報。
 */
export const panic = async (): Promise<PanicResult> => {
  const response = await apiClient.post<PanicResult>('/panic');
  return response.data;
};

/** 安全健康列：熔斷/停用狀態、每日下單計數與上限、連線、對帳落差。 */
export const getSafetyHealth = async (): Promise<SafetyHealth> => {
  const response = await apiClient.get<SafetyHealth>('/safety/health');
  return response.data;
};
