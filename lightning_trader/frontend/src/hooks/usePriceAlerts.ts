/**
 * usePriceAlerts — 監聽 quote stream 偵測價格穿越設定線，觸發 toast + Notification
 *
 * 工作方式：
 *   - 維護 lastPriceRef[symbol] 為上一次看到的價格
 *   - 每次 quote 或 watchlistQuotes 變動：對該 symbol 跑 findTriggered
 *   - 觸發後立刻 toast.warn + 系統 Notification（非聚焦時）+ 把 alert 標記為 triggeredAt
 *
 * 重複防呆：triggeredAt 標記讓「同一個 alert 不會在來回震盪時連發 N 次」。
 * 使用者要重新啟用需到 settings reset / re-enable。
 */
import { useEffect, useRef } from 'react';
import { useSettings } from '../contexts/SettingsContext';
import { useQuotes } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';
import { findTriggered } from '../utils/priceAlerts';
import { formatPrice } from '../utils/instrument';

export function usePriceAlerts(): void {
  const { settings, updateSetting } = useSettings();
  const { quote, watchlistQuotes } = useQuotes(); // 價格警報要即時穿越判定 → 高頻 context
  const { toast } = useToast();
  const lastPriceRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // 收集本輪 (symbol → current price) 的 snapshot
    const updates: Array<[string, number]> = [];
    if (quote?.Symbol && quote.Price > 0) {
      updates.push([String(quote.Symbol).toUpperCase(), quote.Price]);
    }
    for (const sym in watchlistQuotes) {
      const q = watchlistQuotes[sym];
      if (q && q.price > 0) updates.push([sym, q.price]);
    }
    if (updates.length === 0) return;

    const fired: string[] = [];
    for (const [sym, curr] of updates) {
      const prev = lastPriceRef.current.get(sym) ?? 0;
      lastPriceRef.current.set(sym, curr);
      if (prev <= 0) continue;
      const ids = findTriggered(settings.priceAlerts, sym, prev, curr);
      for (const id of ids) {
        const alert = settings.priceAlerts.find((a) => a.id === id);
        if (!alert) continue;
        const sideZh = alert.op === 'above' ? '突破' : '跌破';
        const msg = `🔔 ${sym} ${sideZh} ${formatPrice(alert.price, sym)} (現 ${formatPrice(curr, sym)})`;
        toast.warn(msg, { durationMs: 10000 });
        // 後景時推系統通知
        if (typeof document !== 'undefined' && !document.hasFocus()
            && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            const n = new Notification(`LighTrade 警報：${sym}`, { body: msg, tag: `alert-${id}` });
            n.onclick = () => { window.focus(); n.close(); };
          } catch { /* noop */ }
        }
        fired.push(id);
      }
    }

    if (fired.length > 0) {
      const now = Date.now();
      const next = settings.priceAlerts.map((a) =>
        fired.includes(a.id) ? { ...a, triggeredAt: now } : a,
      );
      updateSetting({ priceAlerts: next });
    }
  }, [quote, watchlistQuotes, settings.priceAlerts, updateSetting, toast]);
}
