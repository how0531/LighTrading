/**
 * domAnchor.ts — DOM ladder 置中錨點輔助（BACKLOG B9）
 *
 * 痛點：DOM 預設只會捲到「現價」；trader 想盯的常是「持倉成本價」。
 * 成本價不一定剛好落在 ladder 的某個 tick 上（股票尤其），需要找最接近的列。
 *
 * 純函式方便單測；不碰 priceBase / ladder 重建（穩定性考量，只改捲動目標）。
 */
export type DomAnchor = 'price' | 'cost';

/**
 * 在 ladder 價格陣列中找與 target 最接近的值。
 * ladder 為 DOMPanel 的 fullPrices（已含上下界、降序）。
 * 空陣列或 target<=0 回 null。並列時取較大值（偏向上方，視覺較直覺）。
 */
export function nearestLadderPrice(target: number, ladder: number[]): number | null {
  if (!(target > 0) || !ladder || ladder.length === 0) return null;
  let best = ladder[0];
  let bestDiff = Math.abs(ladder[0] - target);
  for (let i = 1; i < ladder.length; i++) {
    const d = Math.abs(ladder[i] - target);
    if (d < bestDiff || (d === bestDiff && ladder[i] > best)) {
      best = ladder[i];
      bestDiff = d;
    }
  }
  return best;
}

/**
 * 依錨點決定要捲到的目標價。
 * cost 模式需有有效持倉成本，否則退回現價（caller 可據此 disable UI）。
 */
export function resolveAnchorTarget(
  anchor: DomAnchor,
  currentPrice: number,
  costPrice: number,
): number {
  if (anchor === 'cost' && costPrice > 0) return costPrice;
  return currentPrice;
}
