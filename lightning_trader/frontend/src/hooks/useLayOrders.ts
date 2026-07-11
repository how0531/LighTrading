/**
 * useLayOrders — 鋪單（多價位掛單）主邏輯（Sprint C）
 *
 * 職責：
 *   - submitLay：依 computeLayPrices 展開 N 檔價位，送出前做一次 useConfirm 總確認
 *     （列出檔數 / 總量 / 價格區間），確認後逐檔迴圈送單，沿用批次 3 的
 *     進度 + 中止模式（獨立 layProgress / layAbortRef，不與 splitProgress 打架）。
 *   - 「追價鋪單」：勾選時每檔改送 CHASE 智慧單（buildChasePayload，動態鋪單）。
 *   - cancelLaid（撤鋪單）：記住本次鋪出的委託（普通單記 action+price 走
 *     /cancel_all 刪單 API；CHASE 記智慧單 id 走 DELETE /smart_orders/{id}），
 *     一鍵全撤並 toast 回報成功/失敗數，最後 scheduleOrderRefresh。
 *
 * 鋪單記憶只存在記憶體（頁面刷新即失去「本次鋪單」記憶，UI 有註明）。
 */
import { useState, useRef, useCallback } from 'react';
import { apiClient, normalizeApiError } from '../api/client';
import { useTradingCore } from '../contexts/TradingContext';
import { useSettings } from '../contexts/SettingsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../contexts/ConfirmContext';
import { computeLayPrices } from '../utils/layOrders';
import { buildChasePayload } from '../utils/chase';
import { playSound } from '../utils/sound';
import { formatPrice } from '../utils/instrument';

/** 鋪單進度（與拆單 SplitProgress 同形狀，但完全獨立的 state） */
export interface LayProgress {
  sent: number;
  total: number;
  aborted: boolean;
}

/** 本次鋪出的一筆委託的「撤單線索」 */
export interface LaidOrderRef {
  kind: 'normal' | 'chase';
  symbol: string;
  action: 'Buy' | 'Sell';
  price: number;
  qty: number;
  /** CHASE 智慧單 id（後端建立回應的 id；拿不到就無法單獨撤，計入失敗） */
  smartId?: string;
}

export interface LaySubmitParams {
  side: 'Buy' | 'Sell';
  /** 檔數 N（UI 限 2–10） */
  levels: number;
  startPrice: number;
  /** 間距（tick 數） */
  gapTicks: number;
  qtyPerLevel: number;
  /** 追價鋪單：每檔改送 CHASE 智慧單 */
  useChase: boolean;
  /** 普通單沿用 DOM 當前的信用別 / 整零股別（期貨忽略） */
  orderCond: string;
  orderLot: string;
}

export function useLayOrders() {
  const { targetSymbol, scheduleOrderRefresh, refreshSmartOrders } = useTradingCore();
  const { settings } = useSettings();
  const { toast } = useToast();
  const { confirm } = useConfirm();

  const [layProgress, setLayProgress] = useState<LayProgress | null>(null);
  const layAbortRef = useRef(false);
  const abortLay = useCallback(() => { layAbortRef.current = true; }, []);

  // 本次鋪出的委託（記憶體 only：刷新即失去，UI 註明）
  const [laidOrders, setLaidOrders] = useState<LaidOrderRef[]>([]);
  const isLayingRef = useRef(false);

  const submitLay = useCallback(async (params: LaySubmitParams): Promise<boolean> => {
    const { side, levels, startPrice, gapTicks, qtyPerLevel, useChase, orderCond, orderLot } = params;
    if (!targetSymbol) { toast.error('請先選定商品'); return false; }
    if (isLayingRef.current) { toast.info('鋪單進行中…'); return false; }
    if (qtyPerLevel <= 0) { toast.error('每檔量要 > 0'); return false; }

    const prices = computeLayPrices({ side, levels, startPrice, gapTicks, symbol: targetSymbol });
    if (prices.length === 0) { toast.error('起始價無效，無法計算鋪單價位'); return false; }

    // 送出前一次總確認（列出 N 檔總量與價格區間；danger 樣式視戰鬥模式）
    const dir = side === 'Buy' ? '買進' : '賣出';
    const first = prices[0];
    const last = prices[prices.length - 1];
    const lo = Math.min(first, last);
    const hi = Math.max(first, last);
    const totalQty = prices.length * qtyPerLevel;
    const ok = await confirm({
      title: useChase ? '鋪單確認（追價）' : '鋪單確認',
      message: `確認${dir} ${targetSymbol} 鋪 ${prices.length} 檔 × ${qtyPerLevel} = 共 ${totalQty} 單位？\n`
        + `價格區間 ${formatPrice(lo, targetSymbol)} ~ ${formatPrice(hi, targetSymbol)}（間距 ${gapTicks} tick）`
        + (useChase ? `\n每檔以「追價智慧單」送出（最多追 ${settings.chase.maxChaseTicks} tick）` : ''),
      confirmLabel: `確認鋪 ${prices.length} 檔`,
      danger: settings.isCombatMode,
    });
    if (!ok) return false;

    isLayingRef.current = true;
    layAbortRef.current = false;
    setLayProgress({ sent: 0, total: prices.length, aborted: false });

    const placed: LaidOrderRef[] = [];
    let abortedByUser = false;
    let errored = false;
    // P1-1：鋪單不再無條件帶 confirm:true（那會讓後端 skip_warnings 靜默跳過價格偏離等
    // WARNING，深檔鋪單最會踩）。改為正常送單；第一次遇到 409 CONFIRM_REQUIRED 時彈一次
    // danger 確認，接受後 batchConfirmed=true，套用到本批後續各檔（避免每檔都彈）。
    let batchConfirmed = false;
    try {
      for (let i = 0; i < prices.length; i++) {
        // 每檔送出前檢查中止旗標（UI 的「中止」按鈕）
        if (layAbortRef.current) { abortedByUser = true; break; }
        const price = prices[i];
        try {
          if (useChase) {
            const res = await apiClient.post('/smart_orders', buildChasePayload({
              symbol: targetSymbol,
              action: side,
              quantity: qtyPerLevel,
              maxChaseTicks: settings.chase.maxChaseTicks,
              finalAction: settings.chase.finalAction,
            }));
            const rawId = (res?.data as { id?: string | number } | undefined)?.id;
            placed.push({
              kind: 'chase', symbol: targetSymbol, action: side, price, qty: qtyPerLevel,
              smartId: rawId != null && String(rawId) !== '' ? String(rawId) : undefined,
            });
          } else {
            const basePayload = {
              symbol: targetSymbol, price, action: side, qty: qtyPerLevel,
              order_type: 'ROD', price_type: 'LMT', order_cond: orderCond, order_lot: orderLot,
            };
            try {
              await apiClient.post('/place_order', batchConfirmed ? { ...basePayload, confirm: true } : basePayload);
            } catch (e) {
              const err = normalizeApiError(e);
              if (err.status === 409 && err.code === 'CONFIRM_REQUIRED') {
                if (!batchConfirmed) {
                  const warns = [err.user_msg, ...(err.warnings ?? [])].filter(Boolean).join('\n');
                  const ok = await confirm({
                    title: '鋪單風控警告',
                    message: `此批鋪單觸發後端風控警告：\n${warns}\n\n確認後本批其餘檔位一併以「已確認」送出。`,
                    confirmLabel: '確認整批送出',
                    danger: true,
                  });
                  if (!ok) { abortedByUser = true; break; }
                  batchConfirmed = true;
                }
                // 帶 confirm:true 重送本檔
                await apiClient.post('/place_order', { ...basePayload, confirm: true });
              } else {
                throw e;
              }
            }
            placed.push({ kind: 'normal', symbol: targetSymbol, action: side, price, qty: qtyPerLevel });
          }
          setLayProgress({ sent: placed.length, total: prices.length, aborted: false });
        } catch (e) {
          // 第一檔失敗多半代表後續也會失敗（風控 block / 斷線）→ 停止不再連發
          errored = true;
          const err = normalizeApiError(e);
          toast.error(`鋪單第 ${i + 1} 檔失敗：${err.user_msg}（已停止，成功 ${placed.length} 檔）`);
          break;
        }
      }

      if (abortedByUser) {
        setLayProgress({ sent: placed.length, total: prices.length, aborted: true });
        toast.info(`鋪單已中止，完成 ${placed.length}/${prices.length}`);
      }

      if (placed.length > 0) {
        setLaidOrders((prev) => [...prev, ...placed]);
        playSound('order_placed');
        scheduleOrderRefresh();
        if (useChase) setTimeout(() => refreshSmartOrders(targetSymbol), 200);
        if (!abortedByUser && !errored) {
          toast.success(`鋪單完成：${dir} ${placed.length} 檔 × ${qtyPerLevel}${useChase ? '（追價）' : ''}`);
        }
      }
      return placed.length > 0;
    } finally {
      isLayingRef.current = false;
      setLayProgress(null);
    }
  }, [targetSymbol, settings.chase, settings.isCombatMode, confirm, toast, scheduleOrderRefresh, refreshSmartOrders]);

  /** 撤鋪單：一鍵全撤本次鋪出的委託（普通單走精確價位刪單、CHASE 走智慧單取消） */
  const cancelLaid = useCallback(async () => {
    if (laidOrders.length === 0) return;
    const targets = laidOrders;

    // P1-1：cancelLaid 之前完全無確認、且會跨 symbol 全撤 —— 補一個 danger 確認框，
    // 列出將撤數量與涉及商品（鋪單可能跨商品，記憶體內累積多次鋪單）。
    const symbolsInvolved = Array.from(new Set(targets.map((o) => o.symbol)));
    const ok = await confirm({
      title: '撤鋪單確認',
      message: `確認撤掉本次鋪出的 ${targets.length} 筆委託？`
        + `\n涉及商品：${symbolsInvolved.join('、')}`
        + `\n（普通單依精確價位撤、追價單走智慧單取消）`,
      confirmLabel: `確認撤 ${targets.length} 筆`,
      danger: true,
    });
    if (!ok) return;

    let normalCancelled = 0;   // 後端實際撤掉的普通掛單數（精確價位）
    let chaseOk = 0;           // 成功送出取消的追價智慧單數
    let failCount = 0;
    let hasChase = false;
    for (const o of targets) {
      try {
        if (o.kind === 'chase') {
          hasChase = true;
          if (!o.smartId) { failCount++; continue; }
          await apiClient.delete(`/smart_orders/${encodeURIComponent(o.smartId)}`);
          chaseOk++;
        } else {
          // 精確價位撤單 → 讀後端實際撤單數（該檔可能已成交 → 撤 0，不灌水成功數）
          const res = await apiClient.post('/cancel_all', { symbol: o.symbol, action: o.action, price: o.price });
          const n = Number((res?.data as { cancelled?: number } | undefined)?.cancelled ?? 0);
          normalCancelled += Number.isFinite(n) ? n : 0;
        }
      } catch {
        failCount++;
      }
    }
    setLaidOrders([]);
    scheduleOrderRefresh();
    if (hasChase) setTimeout(() => refreshSmartOrders(targetSymbol), 200);
    playSound('cancel_order');
    const totalCancelled = normalCancelled + chaseOk;
    if (failCount === 0) {
      toast.success(`撤鋪單完成：實際撤 ${totalCancelled} 筆（本次鋪出 ${targets.length} 檔；未撤到的多半已成交）`);
    } else {
      toast.warn(`撤鋪單：實際撤 ${totalCancelled} 筆、失敗 ${failCount}（失敗的請至委託列表手動處理）`);
    }
  }, [laidOrders, scheduleOrderRefresh, refreshSmartOrders, targetSymbol, toast, confirm]);

  return {
    layProgress,
    abortLay,
    submitLay,
    laidOrders,
    cancelLaid,
  };
}
