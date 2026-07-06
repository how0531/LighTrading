/**
 * hotkeyGate — 全域「下單熱鍵閘門」（P0-1）
 *
 * 某些 modal（設定 / 快捷鍵速查表）開啟時，DOMPanel 的全域下單熱鍵
 * （F1 買 / a,s 市價 / q,w 追價…）不得從 modal 背後被觸發。
 *
 * ConfirmDialog 與 MultiDOMGrid 用 capture-phase stopPropagation 攔截；但那會連帶
 * 吞掉 modal 內元素自己的 onKeyDown（例：SettingsModal 的「按鍵捕捉」重綁、Enter 送出），
 * 因此改用一個極輕量的 open-modal 計數旗標：modal mount 時 acquire、unmount 時 release，
 * DOMPanel 的熱鍵處理器開頭檢查 areOrderHotkeysBlocked() 直接放行（不 preventDefault，
 * 讓 modal 內的輸入/快捷照常運作）。
 */
let openBlockingModals = 0;

/** modal 開啟時呼叫，回傳 release 函式（unmount / 關閉時呼叫一次即可，重複呼叫安全）。 */
export function acquireHotkeyBlock(): () => void {
  openBlockingModals += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openBlockingModals = Math.max(0, openBlockingModals - 1);
  };
}

/** 目前是否有會攔截全域下單熱鍵的 modal 開著。 */
export function areOrderHotkeysBlocked(): boolean {
  return openBlockingModals > 0;
}
