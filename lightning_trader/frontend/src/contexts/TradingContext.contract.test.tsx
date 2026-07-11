/**
 * 契約護欄測試（@stable-contract）
 * ============================================================================
 * 斷言 TradingContext 對外暴露的 context value 鍵集合 === 凍結清單：
 *   - useQuotes()      的回傳物件 keys === QUOTES_CONTEXT_KEYS
 *   - useTradingCore() 的回傳物件 keys === TRADING_CORE_CONTEXT_KEYS
 *
 * 目的：任何人日後在 QuotesContextType / TradingCoreContextType 上新增、
 * 移除或改名對外鍵（不論是型別還是 Provider 的 value 物件），CI 會立刻擋下，
 * 迫使變更者同步 docs/CONTRACT.md、src/contracts 的凍結清單與底座掛載契約。
 *
 * 注意：這裡比對的是「執行期真實 value 物件的 keys」（Object.keys），
 * 不只是 TypeScript 型別 —— 型別與實作漂移都逃不掉。
 * ============================================================================
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import {
  TradingProvider,
  useQuotes,
  useTradingCore,
  type QuotesContextType,
  type TradingCoreContextType,
} from './TradingContext';
import { QUOTES_CONTEXT_KEYS, TRADING_CORE_CONTEXT_KEYS } from '../contracts';
import { ToastProvider } from './ToastContext';

vi.mock('../api/client', () => ({
  apiClient: {
    get: vi.fn((url: string) => {
      if (url === '/accounts') return Promise.resolve({ data: [] });
      if (url === '/order_history') return Promise.resolve({ data: { seq_no: 1, orders: [] } });
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

// 只捕捉 value 物件參照，不觸發任何行為
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

const probe: {
  quotes: QuotesContextType | null;
  core: TradingCoreContextType | null;
} = { quotes: null, core: null };

const Probe: React.FC = () => {
  const quotes = useQuotes();
  const core = useTradingCore();
  React.useEffect(() => {
    probe.quotes = quotes;
    probe.core = core;
  });
  return null;
};

async function setup() {
  render(
    <ToastProvider>
      <TradingProvider>
        <Probe />
      </TradingProvider>
    </ToastProvider>,
  );
  // provider 延遲 50ms 才建立 WebSocket；跑過 mount effect 讓 probe 取到 value
  await act(async () => { vi.advanceTimersByTime(60); });
}

describe('TradingContext 對外契約護欄（@stable-contract）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    probe.quotes = null;
    probe.core = null;
    vi.clearAllMocks();
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('useQuotes() 的鍵集合 === 凍結清單 QUOTES_CONTEXT_KEYS', async () => {
    await setup();
    expect(probe.quotes).not.toBeNull();
    const actual = Object.keys(probe.quotes as object).sort();
    const frozen = [...QUOTES_CONTEXT_KEYS].sort();
    expect(actual).toEqual(frozen);
  });

  it('useTradingCore() 的鍵集合 === 凍結清單 TRADING_CORE_CONTEXT_KEYS', async () => {
    await setup();
    expect(probe.core).not.toBeNull();
    const actual = Object.keys(probe.core as object).sort();
    const frozen = [...TRADING_CORE_CONTEXT_KEYS].sort();
    expect(actual).toEqual(frozen);
  });

  it('兩個凍結清單彼此不重疊（高/低頻 context 職責不交叉）', () => {
    const q = new Set<string>(QUOTES_CONTEXT_KEYS);
    const overlap = TRADING_CORE_CONTEXT_KEYS.filter((k) => q.has(k));
    expect(overlap).toEqual([]);
  });

  it('凍結清單無重複鍵', () => {
    expect(new Set(QUOTES_CONTEXT_KEYS).size).toBe(QUOTES_CONTEXT_KEYS.length);
    expect(new Set(TRADING_CORE_CONTEXT_KEYS).size).toBe(TRADING_CORE_CONTEXT_KEYS.length);
  });
});
