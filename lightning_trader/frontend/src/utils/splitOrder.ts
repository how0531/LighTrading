/**
 * splitOrders - 將大型委託拆成多筆隨機張數
 * @param totalQty 總張數
 * @param minPerLot 每筆最少張數
 * @param maxPerLot 每筆最多張數
 * @returns 每筆張數的陣列，總和 === totalQty
 */
export function splitOrders(totalQty: number, minPerLot: number, maxPerLot: number): number[] {
  const min = Math.max(1, minPerLot);
  const max = Math.max(min, maxPerLot);
  const parts: number[] = [];
  let remaining = totalQty;

  while (remaining > 0) {
    // 最後一筆若剩下的比 min 還少，就直接全部放進去
    if (remaining <= min) {
      parts.push(remaining);
      break;
    }
    // 不讓最後一批不足 min 張（若下一筆拿走太多）
    const upperBound = Math.min(max, remaining - min);
    const lot = Math.floor(Math.random() * (upperBound - min + 1)) + min;
    parts.push(lot);
    remaining -= lot;
  }

  return parts;
}

/**
 * randomDelay - 於 minMs ~ maxMs 之間取一隨機延遲
 */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}
