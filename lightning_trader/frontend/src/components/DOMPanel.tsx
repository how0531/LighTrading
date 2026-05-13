import React, { useEffect, useState } from 'react';
import { useDOMLogic } from '../hooks/useDOMLogic';
import { DOMHeader } from './DOM/DOMHeader';
import { DOMTable } from './DOM/DOMTable';
import { DOMFooter } from './DOM/DOMFooter';
import { getTickSize } from '../utils/tickSize';
import { apiClient, normalizeApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { getMultiplier } from '../types';

// 精確四捨五入避免浮點漂移
const round2 = (n: number): number => Math.round(n * 100) / 100;

export const DOMPanel: React.FC = () => {
  const logic = useDOMLogic();
  const { toast } = useToast();
  const {
    qData, currentPrice, refPrice, limitUp, limitDown, highPrice, lowPrice, isSimulation,
    isStale, tableRef, hasScrolled, flashDir,
    orderValue, setOrderValue, orderType, setOrderType, priceType, setPriceType,
    orderCond, setOrderCond, orderLot, setOrderLot, calcAmount, setCalcAmount,
    isSyncing, handleManualSync,
    workingBuyMap, workingSellMap, currentPosition,
    handlePlaceOrder, handleCancelOrder, handleAddStopOrder, handleDropOrder,
    orderFeedback, smartOrders, bData,
    targetSymbol, accounts, activeAccount, selectAccount,
    hotkeys
  } = logic;

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
    return (currentPosition as any)?.backendPnl || 0;
  }, [currentPrice, refPrice, currentPosition, netQty, targetSymbol]);

  // --- 核心：以參考價為中心展開 500 檔價格 ---
  const [priceBase, setPriceBase] = useState(0);

  useEffect(() => {
    if (refPrice > 0) {
      setPriceBase(prev => prev === 0 || prev !== refPrice ? refPrice : prev);
    } else if (currentPrice > 0 && priceBase === 0) {
      setPriceBase(currentPrice);
    }
  }, [refPrice, currentPrice, priceBase]);

  useEffect(() => {
    setPriceBase(0);
  }, [targetSymbol]);

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

  // --- 自動捲動到當前價 ---
  const scrollToCurrentPrice = React.useCallback(() => {
    if (currentPrice > 0) {
      const pKey = Math.round(currentPrice * 100);
      const row = document.querySelector(`[data-price="${pKey}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [currentPrice]);

  useEffect(() => {
    if (currentPrice > 0 && fullPrices.length > 0 && !hasScrolled.current) {
      hasScrolled.current = true;
      setTimeout(() => scrollToCurrentPrice(), 100);
    }
  }, [currentPrice, fullPrices, scrollToCurrentPrice, hasScrolled]);

  useEffect(() => {
    hasScrolled.current = false;
  }, [targetSymbol, hasScrolled]);

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


  // ★ 全域快捷鍵監聽
  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const matched = hotkeys.find((hk: any) => hk.key === e.key);
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
          logic.handleCancelOrder('Buy');
          logic.handleCancelOrder('Sell');
          await handleFlatten();
          break;
        case 'ScrollCenter':
          scrollToCurrentPrice();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeys, handlePlaceOrder, handleCancelOrder, scrollToCurrentPrice, currentPrice, refPrice, targetSymbol, logic]);

  const handleFlatten = async () => {
    try {
      await apiClient.post('/flatten', { symbol: targetSymbol });
      toast.success(`${targetSymbol} 平倉指令已送出`);
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '平倉失敗');
    }
  };

  const handleReverse = async () => {
    try {
      await apiClient.post('/reverse', { symbol: targetSymbol });
      toast.success(`${targetSymbol} 反手指令已送出`);
    } catch (e) {
      const err = normalizeApiError(e);
      toast.error(err.user_msg || '反手失敗');
    }
  };


  return (
    <div className="flex flex-col flex-1 min-h-0 rounded-xl border border-slate-800 bg-[#101623] text-slate-100 relative overflow-hidden shadow-2xl">
      <DOMHeader 
        qData={qData} targetSymbol={targetSymbol} currentPrice={currentPrice} refPrice={refPrice}
        limitUp={limitUp} limitDown={limitDown} isSimulation={isSimulation} fullPrices={fullPrices}
        accounts={accounts} activeAccount={activeAccount} selectAccount={selectAccount}
        currentPosition={currentPosition} realtimePnL={realtimePnL}
        orderType={orderType} setOrderType={setOrderType} priceType={priceType} setPriceType={setPriceType}
        orderCond={orderCond} setOrderCond={setOrderCond} orderLot={orderLot} setOrderLot={setOrderLot}
        calcAmount={calcAmount} setCalcAmount={setCalcAmount} handleAmountConvert={logic.handleAmountConvert || (() => {})}
        orderValue={orderValue} setOrderValue={setOrderValue} scrollToCurrentPrice={scrollToCurrentPrice}
      />
      
      <div ref={tableRef} className="flex-1 overflow-auto bg-black/10 custom-scrollbar">
        <DOMTable 
          fullPrices={fullPrices} isStale={isStale} qData={qData} currentPrice={currentPrice} refPrice={refPrice}
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
