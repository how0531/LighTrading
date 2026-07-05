import React, { useEffect, useRef, useState } from 'react';
import { useDOMLogic } from '../hooks/useDOMLogic';
import { DOMHeader } from './DOM/DOMHeader';
import { DOMTable } from './DOM/DOMTable';
import { DOMFooter } from './DOM/DOMFooter';
import { getTickSize } from '../utils/instrument';
import { apiClient } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { useApiErrorToast } from '../hooks/useApiErrorToast';
import { useSettings } from '../contexts/SettingsContext';
import type { AccountPosition } from '../contexts/TradingContext';
import { getMultiplier } from '../types';
import type { SizingMode } from '../utils/sizing';
import { nearestLadderPrice, resolveAnchorTarget, type DomAnchor } from '../utils/domAnchor';

// 精確四捨五入避免浮點漂移
const round2 = (n: number): number => Math.round(n * 100) / 100;

export const DOMPanel: React.FC = () => {
  const { toast } = useToast();
  const handleApiError = useApiErrorToast();
  const { settings, updateSetting } = useSettings();
  const compactMode = settings.visuals.compactMode;
  const {
    qData, currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice, isSimulation,
    isStale, flashDir,
    orderValue, setOrderValue, orderType, setOrderType, priceType, setPriceType,
    orderCond, setOrderCond, orderLot, setOrderLot,
    isSyncing, handleManualSync,
    workingBuyMap, workingSellMap, currentPosition,
    handlePlaceOrder, handleCancelOrder, handleAddStopOrder, handleDropOrder,
    orderFeedback, smartOrders, bData,
    targetSymbol, accounts, activeAccount, selectAccount,
    hotkeys, accountEquity,
  } = useDOMLogic();

  // ladder scroll 狀態（local ref — 不進 hook，避免跨模組改動 ref.current）
  const tableRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  // --- 損益重算 ---
  const netQty = currentPosition ? (currentPosition.direction === 'Buy' ? currentPosition.qty : -currentPosition.qty) : 0;
  const realtimePnL = React.useMemo(() => {
    if (netQty === 0 || !currentPosition) return 0;
    const cp = currentPrice || refPrice;
    if (cp > 0 && currentPosition && currentPosition.price > 0 && targetSymbol) {
      const multiplier = getMultiplier(targetSymbol);
      const localPnl = Math.round((cp - currentPosition.price) * netQty * multiplier);
      if (localPnl !== 0) return localPnl;
    }
    return (currentPosition as (AccountPosition & { backendPnl?: number }) | null)?.backendPnl || 0;
  }, [currentPrice, refPrice, currentPosition, netQty, targetSymbol]);

  // --- 核心：以參考價為中心展開 500 檔價格 ---
  // 錨定價：有參考價用參考價；沒有就黏滯在「第一筆成交價」（避免每 tick 重建 ladder）。
  // 切換商品歸零。用 render 期 guarded setState（derived-state 模式）取代 effect 內同步 setState。
  const [baseState, setBaseState] = useState<{ symbol: string; price: number }>(
    { symbol: targetSymbol, price: 0 },
  );
  const carriedBase = baseState.symbol === targetSymbol ? baseState.price : 0;
  const priceBase = refPrice > 0
    ? refPrice
    : (carriedBase === 0 && currentPrice > 0 ? currentPrice : carriedBase);
  if (baseState.symbol !== targetSymbol || baseState.price !== priceBase) {
    setBaseState({ symbol: targetSymbol, price: priceBase });
  }

  const fullPrices = React.useMemo(() => {
    if (priceBase <= 0) return [];
    const up = limitUp > 0 ? limitUp : round2(priceBase * 1.1);
    const down = limitDown > 0 ? limitDown : round2(priceBase * 0.9);
    const sym = targetSymbol || '';

    const upper: number[] = [];
    let pUp = priceBase;
    while (pUp <= up && upper.length < 250) {
      const tick = getTickSize(pUp, sym);
      pUp = round2(pUp + tick);
      if (pUp <= up) upper.push(pUp);
    }
    upper.reverse();

    const lower: number[] = [priceBase];
    let pDown = priceBase;
    while (pDown >= down && lower.length < 250) {
      const tick = getTickSize(pDown, sym);
      pDown = round2(pDown - tick);
      if (pDown >= down) lower.push(pDown);
    }

    return [...upper, ...lower];
  }, [priceBase, limitUp, limitDown, targetSymbol]);

  // --- 置中錨點（BACKLOG B9）：現價 vs 持倉成本價 ---
  const [scrollAnchor, setScrollAnchor] = useState<DomAnchor>('price');

  // 依錨點捲動到對應列。成本可能不在 tick 上 → 找最接近的 ladder 列。
  // anchorOverride 讓 ScrollCenter 熱鍵/初始捲動維持「現價」行為不變。
  const scrollToAnchor = React.useCallback((anchorOverride?: DomAnchor) => {
    const anchor = anchorOverride ?? scrollAnchor;
    const cost = currentPosition?.price ?? 0;
    const target = resolveAnchorTarget(anchor, currentPrice, cost);
    const ladderTarget = nearestLadderPrice(target, fullPrices);
    if (ladderTarget == null) return;
    const pKey = Math.round(ladderTarget * 100);
    const row = document.querySelector(`[data-price="${pKey}"]`);
    if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [scrollAnchor, currentPrice, currentPosition, fullPrices]);

  // 既有呼叫點（初始捲動 / ScrollCenter 熱鍵 / 自動跟隨）一律維持「現價」
  const scrollToCurrentPrice = React.useCallback(() => {
    scrollToAnchor('price');
  }, [scrollToAnchor]);

  // DOMHeader 的 onClick 會把 MouseEvent 當第一個參數傳入 —— 不能直接把
  // scrollToAnchor 傳下去（event 會被當成 anchorOverride）；穩定包一層
  // 讓 DOMHeader 的 React.memo 真的能擋掉重繪
  const handleScrollToAnchor = React.useCallback(() => {
    scrollToAnchor();
  }, [scrollToAnchor]);

  useEffect(() => {
    if (currentPrice > 0 && fullPrices.length > 0 && !hasScrolledRef.current) {
      hasScrolledRef.current = true;
      setTimeout(() => scrollToCurrentPrice(), 100);
    }
  }, [currentPrice, fullPrices, scrollToCurrentPrice]);

  useEffect(() => {
    hasScrolledRef.current = false;
  }, [targetSymbol]);

  // ★ 跟隨價格：每 10 秒檢查當前價是不是還在可視範圍。若飄出去就靜默捲回。
  //   不直接綁在 price tick 上，避免使用者手動滾動研究 ladder 時被搶回去。
  //   只有「飄出畫面 > 10 秒」才會校正一次，且不打斷使用者的拖曳。
  useEffect(() => {
    const containerEl = tableRef.current;
    if (!containerEl) return;
    const FOLLOW_INTERVAL_MS = 10_000;
    let userScrolledRecently = false;
    let scrollResetTimer: ReturnType<typeof setTimeout> | null = null;

    // 偵測「最近 3 秒內使用者有手動 scroll」→ 暫不自動跟隨
    const onUserScroll = () => {
      userScrolledRecently = true;
      if (scrollResetTimer) clearTimeout(scrollResetTimer);
      scrollResetTimer = setTimeout(() => { userScrolledRecently = false; }, 3000);
    };
    // wheel / touchmove 才算「使用者主動」；programmatic scroll 不觸發這些事件
    containerEl.addEventListener('wheel',     onUserScroll, { passive: true });
    containerEl.addEventListener('touchmove', onUserScroll, { passive: true });

    const timer = setInterval(() => {
      if (userScrolledRecently || currentPrice <= 0) return;
      const pKey = Math.round(currentPrice * 100);
      const row = containerEl.querySelector<HTMLElement>(`[data-price="${pKey}"]`);
      if (!row) return;
      const containerRect = containerEl.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      // 飄出可視範圍才捲回
      const isVisible = rowRect.top >= containerRect.top
                     && rowRect.bottom <= containerRect.bottom;
      if (!isVisible) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, FOLLOW_INTERVAL_MS);

    return () => {
      containerEl.removeEventListener('wheel',     onUserScroll);
      containerEl.removeEventListener('touchmove', onUserScroll);
      if (scrollResetTimer) clearTimeout(scrollResetTimer);
      clearInterval(timer);
    };
  }, [tableRef, currentPrice]);


  const handleFlatten = React.useCallback(async () => {
    // 平倉確認：戰鬥模式跳過；否則若開啟平倉確認則先問
    if (settings.confirmations.flatten && !settings.isCombatMode) {
      if (!window.confirm(`確認一鍵平倉 ${targetSymbol}？`)) return;
    }
    try {
      await apiClient.post('/flatten', { symbol: targetSymbol });
      toast.success(`${targetSymbol} 平倉指令已送出`);
    } catch (e) {
      handleApiError(e, '平倉失敗');
    }
  }, [targetSymbol, toast, handleApiError, settings.confirmations.flatten, settings.isCombatMode]);

  const handleReverse = React.useCallback(async () => {
    // 反手是「開新倉」，比平倉更該確認；戰鬥模式跳過
    if (settings.confirmations.flatten && !settings.isCombatMode) {
      if (!window.confirm(`確認一鍵反手 ${targetSymbol}？（平倉後反向開倉）`)) return;
    }
    try {
      await apiClient.post('/reverse', { symbol: targetSymbol });
      toast.success(`${targetSymbol} 反手指令已送出`);
    } catch (e) {
      handleApiError(e, '反手失敗');
    }
  }, [targetSymbol, toast, handleApiError, settings.confirmations.flatten, settings.isCombatMode]);

  // ★ 全域快捷鍵監聽
  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // ★ R6b + Sprint 28: 數字鍵 1–9 隨 sizing.mode 切換語意
      //   - lots:       N = N 張/口
      //   - amount:     N = N × hotkeyAmountUnit （預設 10萬 → 1=10萬, 5=50萬）
      //   - equity_pct: N = N × hotkeyEquityPctUnit（預設 5% → 1=5%, 4=20%，capped 100）
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const N = Number(e.key);
        const mode: SizingMode = settings.sizing.mode;
        if (mode === 'lots') {
          setOrderValue(N);
        } else if (mode === 'amount') {
          updateSetting({
            sizing: { ...settings.sizing, amount: N * settings.sizing.hotkeyAmountUnit },
          });
        } else if (mode === 'equity_pct') {
          updateSetting({
            sizing: {
              ...settings.sizing,
              equityPct: Math.min(100, N * settings.sizing.hotkeyEquityPctUnit),
            },
          });
        }
        return;
      }

      const matched = hotkeys.find((hk) => hk.key === e.key);
      if (!matched) return;

      e.preventDefault();
      const cp = currentPrice || refPrice;

      switch (matched.action) {
        case 'Buy':
          if (cp > 0) handlePlaceOrder(cp, 'Buy');
          break;
        case 'Sell':
          if (cp > 0) handlePlaceOrder(cp, 'Sell');
          break;
        case 'CancelAll':
          handleCancelOrder('Buy');
          handleCancelOrder('Sell');
          break;
        case 'Flatten':
          // B1 fix: 平倉前必須兩側都撤單，否則殘留掛單會被吃進新部位
          handleCancelOrder('Buy');
          handleCancelOrder('Sell');
          await handleFlatten();
          break;
        case 'ScrollCenter':
          scrollToCurrentPrice();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeys, handlePlaceOrder, handleCancelOrder, handleFlatten, scrollToCurrentPrice, currentPrice, refPrice, setOrderValue, settings.sizing, updateSetting]);


  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-slate-800 bg-[#101623] text-slate-100 relative overflow-hidden shadow-2xl">
      <DOMHeader
        qData={qData} targetSymbol={targetSymbol} currentPrice={currentPrice} refPrice={refPrice}
        limitUp={limitUp} limitDown={limitDown} isSimulation={isSimulation} fullPrices={fullPrices}
        accounts={accounts} activeAccount={activeAccount} selectAccount={selectAccount}
        currentPosition={currentPosition} realtimePnL={realtimePnL}
        orderType={orderType} setOrderType={setOrderType} priceType={priceType} setPriceType={setPriceType}
        orderCond={orderCond} setOrderCond={setOrderCond} orderLot={orderLot} setOrderLot={setOrderLot}
        orderValue={orderValue} setOrderValue={setOrderValue}
        accountEquity={accountEquity}
        scrollAnchor={scrollAnchor} setScrollAnchor={setScrollAnchor}
        onScrollToAnchor={handleScrollToAnchor}
      />
      
      <div ref={tableRef} className="flex-1 overflow-auto bg-black/10 custom-scrollbar">
        <DOMTable
          fullPrices={fullPrices} isStale={isStale} compactMode={compactMode} qData={qData} currentPrice={currentPrice} refPrice={refPrice}
          limitUp={limitUp} limitDown={limitDown} highPrice={highPrice} lowPrice={lowPrice} targetSymbol={targetSymbol}
          currentPosition={currentPosition} flashDir={flashDir} smartOrders={smartOrders}
          workingBuyMap={workingBuyMap} workingSellMap={workingSellMap} bData={bData}
          orderFeedback={orderFeedback} handleAddStopOrder={handleAddStopOrder} handleCancelOrder={handleCancelOrder}
          handlePlaceOrder={handlePlaceOrder} handleDropOrder={handleDropOrder}
        />
      </div>

      <DOMFooter 
        isSyncing={isSyncing} handleManualSync={handleManualSync} handleCancelOrder={handleCancelOrder}
        handleFlatten={handleFlatten} handleReverse={handleReverse}
      />
    </div>
  );
};

export default DOMPanel;
