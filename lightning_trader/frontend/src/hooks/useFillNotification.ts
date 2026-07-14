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

// C4：diff 後援路徑 vs recentFills 主路徑的「已涵蓋量」對帳。
//
// 舊版用 `symbol|action|price` 布林集合當去重鍵：只要該價位曾被主路徑涵蓋過一次，
// diff 路徑就永遠視為「已播」——同價位第二筆成交（尤其換一張新單掛在同價）會被永久
// 遮蔽而漏通知。改為「累計量」對帳：把主路徑（recentFills）每筆成交量累加進各 sig 的
// 涵蓋餘額，diff 每筆 delta 依序扣抵；扣得完＝主路徑已播、不重播，扣不完＝主路徑漏了
// （TradeUpdate 沒送到）→ 照播。fill id 只計入涵蓋量一次，且隨 recentFills 視窗汰換而清掉。
export interface CoverageState {
  /** 已累加進涵蓋餘額的 recentFills fill id（避免同一筆重複加總） */
  countedFillIds: Set<string>;
  /** 各 sig（symbol|action|price）尚未被 diff 扣抵的主路徑成交量 */
  coverRemaining: Map<string, number>;
}

export function fillSig(o: { symbol: string; action: string; price: number }): string {
  return `${o.symbol}|${o.action}|${o.price}`;
}

/** 依 recentFills 更新涵蓋餘額、扣抵 diff deltas，回傳仍需由 diff 路徑播報的清單。state 就地更新。 */
export function reconcileDiffCoverage(
  deltas: FillDelta[],
  recentFills: { id: string; symbol: string; action: string; price: number; qty: number }[],
  state: CoverageState,
): FillDelta[] {
  // 1) 把新的 recentFills 成交量累加進涵蓋餘額（每個 fill id 只計一次）；
  //    已汰出 recentFills 視窗的 id 從 counted 移除，避免無上限成長。
  const live = new Set(recentFills.map((f) => f.id));
  for (const id of state.countedFillIds) {
    if (!live.has(id)) state.countedFillIds.delete(id);
  }
  for (const f of recentFills) {
    if (state.countedFillIds.has(f.id)) continue;
    state.countedFillIds.add(f.id);
    const sig = fillSig(f);
    state.coverRemaining.set(sig, (state.coverRemaining.get(sig) ?? 0) + f.qty);
  }
  // 2) 逐筆 delta 用涵蓋餘額扣抵：扣得完 → 主路徑已涵蓋、不重播；扣不完 → 照播。
  const toAnnounce: FillDelta[] = [];
  for (const d of deltas) {
    const sig = fillSig(d.order);
    const remaining = state.coverRemaining.get(sig) ?? 0;
    if (remaining >= d.newFills) {
      const left = remaining - d.newFills;
      if (left > 0) state.coverRemaining.set(sig, left);
      else state.coverRemaining.delete(sig);
      continue;
    }
    if (remaining > 0) state.coverRemaining.delete(sig); // 用掉殘餘涵蓋量，剩下的照播
    toAnnounce.push(d);
  }
  return toAnnounce;
}

const MAX_ANNOUNCED_IDS = 500;

export function useFillNotification(): void {
  const { workingOrders, recentFills } = useTradingCore();
  const { toast } = useToast();
  // 上一輪 snapshot 的 filled_qty，用 order_id（或 fallback compound key）索引
  const lastFilledRef = useRef<Map<string, number>>(new Map());
  // 兩條路徑共用的「已播報」成交 id（TradeUpdate 真 id / compound fallback / diff 合成 id）
  const announcedIdsRef = useRef<Set<string>>(new Set());
  // C4：diff 後援路徑與主路徑的「已涵蓋量」對帳狀態（跨 render 保存）
  const coverageStateRef = useRef<CoverageState>({ countedFillIds: new Set(), coverRemaining: new Map() });
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
    // diffKey 去重：同一 snapshot 重跑（同一 order 同一累計 filled_qty）不重算。
    // 每個增量只會產生一次 delta（下一輪 lastFilled 已含此量），此處是額外保險。
    const fresh: FillDelta[] = [];
    for (const d of deltas) {
      const diffKey = `diff:${d.key}#${d.order.filled_qty}`;
      if (announcedIdsRef.current.has(diffKey)) continue;
      rememberAnnounced(diffKey);
      fresh.push(d);
    }
    // C4：統一去重口徑 —— diff 路徑是 TradeUpdate 的後援。改用「累計已涵蓋量」對帳
    //（reconcileDiffCoverage）：主路徑（recentFills）已涵蓋的量扣抵掉、不重播；主路徑漏送的
    // 量照播。舊版用 symbol|action|price 布林集合，同價第二筆會被永久遮蔽漏通知。
    // 注意：即使本輪沒有 fresh delta，也要呼叫以把新 recentFills 的量先累加進涵蓋餘額，
    // 供之後才到的 diff delta 扣抵。
    const toAnnounce = reconcileDiffCoverage(fresh, recentFills, coverageStateRef.current);
    for (const { order: o, newFills, key: k } of toAnnounce) {
      const sideZh = o.action === 'Buy' ? '買進' : '賣出';
      const title = `已成交 ${newFills} 口 ${o.symbol}`;
      const body = `${sideZh} @${o.price}  (累計 ${o.filled_qty}/${o.qty})`;
      announce(title, body, k);
    }
    lastFilledRef.current = nextFilled;
  }, [workingOrders, recentFills, announce, rememberAnnounced]);
}
