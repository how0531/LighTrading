/**
 * useFillNotification — 委託成交時觸發桌面/瀏覽器通知
 *
 * 行為：
 *   - 第一次掛 hook 時嘗試請求 Notification 權限（granted/denied/default 都記住）
 *   - 主要路徑（Item 12）：消費 TradingContext 的 recentFills（WS TradeUpdate 正規化
 *     事件）。全成單會直接從 workingOrders 消失、diff 不到 —— 這條路徑補上
 *     「一張單全成」這個最常見情境。
 *   - fallback 路徑：監聽 workingOrders 變化，若有 order 的 filled_qty 上升
 *     觸發通知（TradeUpdate 沒送到時的保險）。兩條路徑共用 announced-ids
 *     去重，TradeUpdate 已播過的成交 diff 路徑 best-effort 不重播。
 *   - 視窗在前景就不彈通知（document.hasFocus()），避免擾人；
 *     使用者注意力在別處才推送
 *
 * 純瀏覽器 fallback：Notification API 全平台支援；Electron 預設啟用、不需額外設定。
 * 失敗的 fallback：也呼叫一次 toast.success，所以即使通知權限被拒也能在 app 內看到。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useTradingCore } from '../contexts/TradingContext';
import { useToast } from '../contexts/ToastContext';
import { playSound } from '../utils/sound';

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

const MAX_ANNOUNCED_IDS = 500;

export function useFillNotification(): void {
  const { workingOrders, recentFills } = useTradingCore();
  const { toast } = useToast();
  // 上一輪 snapshot 的 filled_qty，用 order_id（或 fallback compound key）索引
  const lastFilledRef = useRef<Map<string, number>>(new Map());
  // 兩條路徑共用的「已播報」成交 id（TradeUpdate 真 id / compound fallback / diff 合成 id）
  const announcedIdsRef = useRef<Set<string>>(new Set());
  const permissionRequestedRef = useRef(false);

  const rememberAnnounced = useCallback((id: string) => {
    const set = announcedIdsRef.current;
    set.add(id);
    if (set.size > MAX_ANNOUNCED_IDS) {
      // 砍最舊一半（Set 迭代順序 = 插入順序）
      const it = set.values();
      for (let i = 0; i < MAX_ANNOUNCED_IDS / 2; i++) {
        const v = it.next();
        if (v.done) break;
        set.delete(v.value);
      }
    }
  }, []);

  // 共用的播報動作：音效 + （後景時）系統通知 + Toast
  const announce = useCallback((title: string, body: string, tag: string) => {
    playSound('fill'); // 成交提示音（開關/音量由 settings.notifications.sound 控制）
    const inFocus = typeof document !== 'undefined' && document.hasFocus();
    const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
    if (granted && !inFocus) {
      try {
        const n = new Notification(title, {
          body,
          tag: `fill-${tag}`,
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
  }, [toast]);

  // 第一次掛載：請求通知權限（only 一次；之後 settings 改了由使用者自己處理）
  useEffect(() => {
    if (permissionRequestedRef.current) return;
    permissionRequestedRef.current = true;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => { /* 拒絕就算了 */ });
    }
  }, []);

  // Item 12 主要路徑：TradeUpdate 驅動的 recentFills（全成單也播得到）
  useEffect(() => {
    if (!recentFills || recentFills.length === 0) return;
    // recentFills 新的在前 → 反向迭代，通知照時間序發出
    for (let i = recentFills.length - 1; i >= 0; i--) {
      const f = recentFills[i];
      if (announcedIdsRef.current.has(f.id)) continue;
      rememberAnnounced(f.id);
      // action 'Unknown'（payload 缺方向）→ 中性文案「成交」，不臆測買/賣
      const sideZh = f.action === 'Buy' ? '買進' : f.action === 'Sell' ? '賣出' : '成交';
      announce(`已成交 ${f.qty} 口 ${f.symbol}`, `${sideZh} @${f.price}`, f.id);
    }
  }, [recentFills, announce, rememberAnnounced]);

  // fallback 路徑：比對 workingOrders — filled_qty 上升 = 有新成交
  useEffect(() => {
    if (!workingOrders || workingOrders.length === 0) {
      lastFilledRef.current.clear();
      return;
    }

    const { deltas, nextFilled } = diffFills(workingOrders as SimpleOrder[], lastFilledRef.current);
    // P2：統一去重口徑 —— diff 路徑是 TradeUpdate 的後援。TradeUpdate（recentFills）帶真 id
    // 時，diff 路徑的 compoundId（order_id#price#qty）永遠對不上真 id → 同筆會雙播
    // （市價單/優價成交最容易踩）。改為：若 recentFills 已涵蓋同 symbol|action|price，
    // 視為主路徑已播、diff 路徑不再重播；仍更新 lastFilled 避免之後重算成 delta。
    const coveredSig = new Set<string>();
    for (const f of recentFills) coveredSig.add(`${f.symbol}|${f.action}|${f.price}`);
    for (const { order: o, newFills, key: k } of deltas) {
      const diffKey = `diff:${k}#${o.filled_qty}`;
      if (announcedIdsRef.current.has(diffKey)) continue;
      if (coveredSig.has(`${o.symbol}|${o.action}|${o.price}`)) {
        // TradeUpdate 主路徑已涵蓋此成交 → 記下 diffKey 防日後重播，但不再發第二次通知
        rememberAnnounced(diffKey);
        continue;
      }
      rememberAnnounced(diffKey);
      const sideZh = o.action === 'Buy' ? '買進' : '賣出';
      const title = `已成交 ${newFills} 口 ${o.symbol}`;
      const body = `${sideZh} @${o.price}  (累計 ${o.filled_qty}/${o.qty})`;
      announce(title, body, k);
    }
    lastFilledRef.current = nextFilled;
  }, [workingOrders, recentFills, announce, rememberAnnounced]);
}
