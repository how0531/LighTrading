/**
 * 活躍委託狀態的唯一定義。
 * 後端的對應版本是 backend/services/order_sync.py 的 ACTIVE_STATUSES ——
 * 之前這組字串在前端散落 5 份複製，後端改狀態集合時很容易漏改
 * 其中一份，造成不同面板對「哪些單還活著」意見不一致。
 */
export const ACTIVE_ORDER_STATUSES = [
  'PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled',
] as const;

export function isActiveOrderStatus(status: string | undefined | null): boolean {
  return (ACTIVE_ORDER_STATUSES as readonly string[]).includes(status ?? '');
}
