/**
 * useFillNotification — 委託成交時觸發桌面/瀏覽器通知
 *
 * 行為：
 *   - 第一次掛 hook 時嘗試請求 Notification 權限（granted/denied/default 都記住）
 *   - 監聽 workingOrders 變化：若有 order 從未成交變成 PartFilled/Filled，
 *     觸發 Notification("已成交 …")
 *   - 視窗在前景就不彈通知（document.hasFocus()），避免擾人；
 *     使用者注意力在別處才推送
 *
 * 純瀏覽器 fallback：Notification API 全平台支援；Electron 預設啟用、不需額外設定。
 * 失敗的 fallback：也呼叫一次 toast.success，所以即使通知權限被拒也能在 app 內看到。
 */
import { useEffect, useRef } from 'react';
import { useTradingCore } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';

export type SimpleOrder = {
  order_id?: string;
  symbol: string;
  action: 'Buy' | 'Sell';
  price: number;
  qty: number;
  filled_qty: number;
  status: string;
};

// 若 order_id 存在就拿它（最穩定）；只有完全缺 id 才走 compound fallback。
// 之前 orderKey 一律拼 compound key，會在 backend 偶爾省略 order_id 時
// 把同一張單看成兩張，造成 filled_qty 從 0 跳到 N 時觸發兩次 notification。
export function orderKey(o: SimpleOrder): string {
  if (o.order_id) return `id:${o.order_id}`;
  return `c:${o.symbol}|${o.action}|${o.price}|${o.qty}`;
}

// 純函式：diff 上一輪 filled snapshot 與本輪 orders，吐出「新成交」清單。
// 抽出來方便獨立測試（無 React、無 Notification）。
export interface FillDelta {
  order: SimpleOrder;
  newFills: number;
  key: string;
}
export function diffFills(
  orders: SimpleOrder[],
  lastFilled: Map<string, number>,
): { deltas: FillDelta[]; nextFilled: Map<string, number> } {
  const next = new Map<string, number>();
  const deltas: FillDelta[] = [];
  for (const o of orders) {
    const k = orderKey(o);
    const prev = lastFilled.get(k) ?? 0;
    if (o.filled_qty > prev) {
      deltas.push({ order: o, newFills: o.filled_qty - prev, key: k });
    }
    next.set(k, o.filled_qty);
  }
  return { deltas, nextFilled: next };
}

export function useFillNotification(): void {
  const { workingOrders } = useTradingCore();
  const { toast } = useToast();
  // 上一輪 snapshot 的 filled_qty，用 order_id（或 fallback compound key）索引
  const lastFilledRef = useRef<Map<string, number>>(new Map());
  const permissionRequestedRef = useRef(false);

  // 第一次掛載：請求通知權限（only 一次；之後 settings 改了由使用者自己處理）
  useEffect(() => {
    if (permissionRequestedRef.current) return;
    permissionRequestedRef.current = true;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => { /* 拒絕就算了 */ });
    }
  }, []);

  // 比對 workingOrders：filled_qty 上升 = 有新成交
  useEffect(() => {
    if (!workingOrders || workingOrders.length === 0) {
      lastFilledRef.current.clear();
      return;
    }

    const { deltas, nextFilled } = diffFills(workingOrders as SimpleOrder[], lastFilledRef.current);
    for (const { order: o, newFills, key: k } of deltas) {
      const sideZh = o.action === 'Buy' ? '買進' : '賣出';
      const title = `已成交 ${newFills} 口 ${o.symbol}`;
      const body = `${sideZh} @${o.price}  (累計 ${o.filled_qty}/${o.qty})`;
      // 視窗在前景就不出系統通知，只走 Toast；後景才推送
      const inFocus = typeof document !== 'undefined' && document.hasFocus();
      const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
      if (granted && !inFocus) {
        try {
          const n = new Notification(title, {
            body,
            tag: `fill-${k}`,
            silent: false,
          });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        } catch { /* iOS Safari 某些情境會拋；fallback to toast */ }
      }
      // 不論有沒有系統通知，都附一個 Toast；視窗在前景時這是唯一回饋
      toast.success(`${title} — ${body}`);
    }
    lastFilledRef.current = nextFilled;
  }, [workingOrders, toast]);
}
