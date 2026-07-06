import { describe, it, expect, beforeEach } from 'vitest';
import { getApiToken, setApiToken, resolveWsUrl, API_TOKEN_STORAGE_KEY } from './backendUrl';
import { apiClient } from '../api/client';

describe('API token plumbing', () => {
  beforeEach(() => localStorage.clear());

  it('setApiToken/getApiToken round-trip and clear', () => {
    setApiToken('  secret-1 ');
    expect(localStorage.getItem(API_TOKEN_STORAGE_KEY)).toBe('secret-1');
    expect(getApiToken()).toBe('secret-1');
    setApiToken('');
    expect(localStorage.getItem(API_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('resolveWsUrl appends ?token= only when set', () => {
    expect(resolveWsUrl()).toBe('ws://127.0.0.1:8000/ws/quotes'); // jsdom host = localhost
    setApiToken('tok/=x');
    expect(resolveWsUrl()).toBe(`ws://127.0.0.1:8000/ws/quotes?token=${encodeURIComponent('tok/=x')}`);
  });

  it('axios interceptor attaches X-API-Token except /health', async () => {
    setApiToken('tok123');
    const handlers = (apiClient.interceptors.request as unknown as {
      handlers: Array<{ fulfilled: (c: { url: string; headers: Map<string, string> }) => { headers: Map<string, string> } }>;
    }).handlers;
    expect(handlers.length).toBeGreaterThan(0);
    const run = (url: string) => {
      const headers = new Map<string, string>();
      return handlers[0].fulfilled({ url, headers }).headers;
    };
    expect(run('/place_order').get('X-API-Token')).toBe('tok123');
    expect(run('/health').get('X-API-Token')).toBeUndefined();
    setApiToken('');
    expect(run('/place_order').get('X-API-Token')).toBeUndefined();
  });
});
