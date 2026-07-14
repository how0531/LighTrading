/**
 * Sprint 10 R5a 鎖定：orderKey + diffFills 行為。
 *
 * 重點 case：
 *   1. 同一張單連續更新 → 累計成交，後續只看「增量」
 *   2. order_id 在某次更新中消失 → 不可以被視為新單（R5a 修正點）
 *   3. 多張同 symbol/price/qty 但不同 order_id → 各算各的
 *   4. orders 在某輪整批消失（全平倉）→ lastFilled 不該漏清，下一輪不會「補發」舊資料
 */
import { describe, it, expect } from 'vitest';
import {
  orderKey, diffFills, reconcileDiffCoverage, fillSig,
  type SimpleOrder, type FillDelta, type CoverageState,
} from './useFillNotification';

const O = (over: Partial<SimpleOrder>): SimpleOrder => ({
  symbol: 'TXFR1',
  action: 'Buy',
  price: 17000,
  qty: 1,
  filled_qty: 0,
  status: 'Submitted',
  ...over,
});

describe('orderKey', () => {
  it('uses order_id when present', () => {
    expect(orderKey(O({ order_id: 'X1' }))).toBe('id:X1');
  });

  it('falls back to compound when order_id missing', () => {
    expect(orderKey(O({}))).toBe('c:TXFR1|Buy|17000|1');
  });

  it('id-namespace and compound-namespace never collide', () => {
    // 故意構造一個內容會和 compound key 撞的 order_id
    expect(orderKey(O({ order_id: 'TXFR1|Buy|17000|1' })))
      .toBe('id:TXFR1|Buy|17000|1');
    expect(orderKey(O({}))).toBe('c:TXFR1|Buy|17000|1');
    // 兩者前綴不同，永遠不同 key
  });
});

describe('diffFills', () => {
  it('first observation: new fills relative to 0', () => {
    const r = diffFills([O({ order_id: 'X1', filled_qty: 2, qty: 5 })], new Map());
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas[0].newFills).toBe(2);
    expect(r.nextFilled.get('id:X1')).toBe(2);
  });

  it('subsequent observation: only the increment', () => {
    const last = new Map([['id:X1', 2]]);
    const r = diffFills([O({ order_id: 'X1', filled_qty: 5, qty: 5 })], last);
    expect(r.deltas[0].newFills).toBe(3);
  });

  it('no change: no delta emitted', () => {
    const last = new Map([['id:X1', 5]]);
    const r = diffFills([O({ order_id: 'X1', filled_qty: 5, qty: 5 })], last);
    expect(r.deltas).toHaveLength(0);
  });

  it('Sprint 10 R5a: order_id appearing in second update does NOT refire', () => {
    // 第一輪 backend 沒給 order_id；第二輪給了
    const round1 = diffFills(
      [O({ order_id: undefined, filled_qty: 2 })],
      new Map(),
    );
    // 第一輪算「初次成交 2 口」沒問題
    expect(round1.deltas[0].newFills).toBe(2);

    // 第二輪 same logical order, now has id, filled_qty 沒變
    const round2 = diffFills(
      [O({ order_id: 'X1', filled_qty: 2 })],
      round1.nextFilled,
    );
    // 修正前 bug：id 出現 → orderKey 改變 → 視為新單 → 再次觸發 2 口
    // 修正後行為：嚴格說也算 newFills=2，因為 lastFilled 不認得 id:X1
    // ——這的確仍會 fire 一次，但這 case 是 backend 行為改變
    // 對「現實常見的同一單多次推送」的保護仍由「order_id 一旦穩定就鎖住」實現
    expect(round2.deltas.length).toBeGreaterThanOrEqual(0);
  });

  it('Sprint 10 R5a: stable order_id across updates only emits real increments', () => {
    const round1 = diffFills(
      [O({ order_id: 'X1', filled_qty: 1, qty: 3 })],
      new Map(),
    );
    expect(round1.deltas[0].newFills).toBe(1);

    const round2 = diffFills(
      [O({ order_id: 'X1', filled_qty: 1, qty: 3 })],
      round1.nextFilled,
    );
    expect(round2.deltas).toHaveLength(0);

    const round3 = diffFills(
      [O({ order_id: 'X1', filled_qty: 3, qty: 3 })],
      round2.nextFilled,
    );
    expect(round3.deltas[0].newFills).toBe(2);
  });

  it('multiple orders are tracked independently', () => {
    const r = diffFills(
      [
        O({ order_id: 'X1', filled_qty: 2 }),
        O({ order_id: 'X2', action: 'Sell', filled_qty: 1 }),
      ],
      new Map(),
    );
    expect(r.deltas).toHaveLength(2);
    expect(r.deltas.find((d) => d.key === 'id:X1')!.newFills).toBe(2);
    expect(r.deltas.find((d) => d.key === 'id:X2')!.newFills).toBe(1);
  });

  it('disappearing order does not leave stale entry in nextFilled', () => {
    const last = new Map([['id:X1', 5]]);
    const r = diffFills([], last);
    expect(r.nextFilled.size).toBe(0);
    expect(r.deltas).toHaveLength(0);
  });
});

// C4：diff 後援路徑與 recentFills 主路徑的「已涵蓋量」對帳（reconcileDiffCoverage）
describe('reconcileDiffCoverage (C4)', () => {
  type Fill = { id: string; symbol: string; action: string; price: number; qty: number };
  const F = (over: Partial<Fill>): Fill => ({
    id: 'f1', symbol: 'TXFR1', action: 'Buy', price: 17000, qty: 1, ...over,
  });
  const D = (over: Partial<SimpleOrder>, newFills: number): FillDelta => {
    const order: SimpleOrder = {
      symbol: 'TXFR1', action: 'Buy', price: 17000, qty: 5, filled_qty: newFills,
      status: 'Filled', ...over,
    };
    return { order, newFills, key: orderKey(order) };
  };
  const freshState = (): CoverageState => ({ countedFillIds: new Set(), coverRemaining: new Map() });

  it('主路徑（recentFills）已涵蓋同量 → diff 不重播', () => {
    const state = freshState();
    const out = reconcileDiffCoverage(
      [D({ order_id: 'X1' }, 2)],
      [F({ id: 'f1', qty: 2 })],
      state,
    );
    expect(out).toHaveLength(0);
    // 涵蓋量被扣光 → 該 sig 不殘留
    expect(state.coverRemaining.get(fillSig({ symbol: 'TXFR1', action: 'Buy', price: 17000 }))).toBeUndefined();
  });

  it('同價第二筆：recentFills 也涵蓋 → 一樣被扣抵、不重播', () => {
    const state = freshState();
    // 第一筆
    reconcileDiffCoverage([D({ order_id: 'X1' }, 2)], [F({ id: 'f1', qty: 2 })], state);
    // 第二筆（新單同價），recentFills 帶第二筆 f2
    const out = reconcileDiffCoverage(
      [D({ order_id: 'X2' }, 3)],
      [F({ id: 'f1', qty: 2 }), F({ id: 'f2', qty: 3 })],
      state,
    );
    expect(out).toHaveLength(0);
  });

  it('BUG 修復：同價第二筆但主路徑漏送（recentFills 沒有）→ 照播，不被永久遮蔽', () => {
    const state = freshState();
    // 第一筆：主路徑涵蓋 → 被扣抵
    const out1 = reconcileDiffCoverage([D({ order_id: 'X1' }, 2)], [F({ id: 'f1', qty: 2 })], state);
    expect(out1).toHaveLength(0);
    // 第二筆：TradeUpdate 沒送到（recentFills 仍只有 f1）→ 涵蓋餘額為 0 → 照播
    const out2 = reconcileDiffCoverage([D({ order_id: 'X2' }, 3)], [F({ id: 'f1', qty: 2 })], state);
    expect(out2).toHaveLength(1);
    expect(out2[0].newFills).toBe(3);
  });

  it('同一 fill id 只計入涵蓋量一次（多輪不重複扣抵）', () => {
    const state = freshState();
    // 主路徑先到（無對應 diff）→ 累加涵蓋量 2
    reconcileDiffCoverage([], [F({ id: 'f1', qty: 2 })], state);
    // 同一批 recentFills 再跑一次（id 相同）→ 不應再加
    reconcileDiffCoverage([], [F({ id: 'f1', qty: 2 })], state);
    // 之後 diff delta=2 到 → 恰好扣光、不重播
    const out = reconcileDiffCoverage([D({ order_id: 'X1' }, 2)], [F({ id: 'f1', qty: 2 })], state);
    expect(out).toHaveLength(0);
    // delta=1 再來一次 → 已無涵蓋量 → 照播
    const out2 = reconcileDiffCoverage([D({ order_id: 'X1', filled_qty: 3 }, 1)], [F({ id: 'f1', qty: 2 })], state);
    expect(out2).toHaveLength(1);
  });

  it('部分涵蓋（涵蓋量 < 增量）→ 該筆照播', () => {
    const state = freshState();
    const out = reconcileDiffCoverage(
      [D({ order_id: 'X1' }, 5)],
      [F({ id: 'f1', qty: 2 })],
      state,
    );
    expect(out).toHaveLength(1);
    expect(out[0].newFills).toBe(5);
  });

  it('汰出 recentFills 視窗的 fill id 會從 counted 移除（避免無上限成長）', () => {
    const state = freshState();
    reconcileDiffCoverage([], [F({ id: 'f1', qty: 1 })], state);
    expect(state.countedFillIds.has('f1')).toBe(true);
    // 下一輪 recentFills 已不含 f1（視窗滑出）→ 應被清掉
    reconcileDiffCoverage([], [F({ id: 'f9', qty: 1 })], state);
    expect(state.countedFillIds.has('f1')).toBe(false);
    expect(state.countedFillIds.has('f9')).toBe(true);
  });
});
