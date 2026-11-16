/**
 * 定尺への割り付けと歩留まり(J-01 包み 7)の検査。期待は手で詰めた値(長い順に、先に入る棒へ入れる。切断代は部材の間ごと)。
 */
import { describe, expect, it } from 'vitest';

import { planStockCutting } from './stockCutting.js';

describe('定尺への割り付けと歩留まり', () => {
  it('定尺 6000・切断代 3 で 2500×2・1500×3・900×1 は 2 本(5906 と 4506)、歩留まり 10400 ÷ 12000', () => {
    const result = planStockCutting([{ key: 'a', lengthMm: 2500, quantity: 2 }, { key: 'b', lengthMm: 1500, quantity: 3 },
      { key: 'c', lengthMm: 900, quantity: 1 }], 6000, 3);
    if (!result.ok) throw new Error(result.reason);
    expect(result.bars.map((bar) => [bar.cuts.map((cut) => cut.lengthMm), bar.usedMm, bar.offcutMm])).toEqual([
      [[2500, 2500, 900], 5906, 94], [[1500, 1500, 1500], 4506, 1494]]);
    expect(result.totalCutMm).toBe(10400);
    expect(result.yieldRatio).toBeCloseTo(10400 / 12000, 12);
  });

  it('切断代 0 ならちょうど埋まる棒は 1 本、切断代があると 2 本になる', () => {
    const cuts = [{ key: 'a', lengthMm: 500, quantity: 2 }];
    const exact = planStockCutting(cuts, 1000, 0);
    expect(exact.ok ? exact.bars.map((bar) => bar.offcutMm) : null).toEqual([0]);
    expect(exact.ok ? exact.yieldRatio : null).toBe(1);
    const kerf = planStockCutting(cuts, 1000, 3);
    expect(kerf.ok ? kerf.bars.length : null).toBe(2);
  });

  it('定尺より長い部材・数でない定尺と切断代・数でない部材は割り付けず、理由と行の鍵を返す。部材が無ければ棒も 0 本', () => {
    expect(planStockCutting([{ key: 'long', lengthMm: 6500, quantity: 1 }], 6000, 3)).toEqual({ ok: false, reason: 'tooLong', key: 'long' });
    expect(planStockCutting([], 0, 3)).toEqual({ ok: false, reason: 'invalidStock', key: null });
    expect(planStockCutting([], 6000, -1)).toEqual({ ok: false, reason: 'invalidKerf', key: null });
    expect(planStockCutting([{ key: 'x', lengthMm: Number.NaN, quantity: 1 }], 6000, 0)).toEqual({ ok: false, reason: 'invalidCut', key: 'x' });
    expect(planStockCutting([], 6000, 0)).toEqual({ ok: true, bars: [], totalCutMm: 0, yieldRatio: 0 });
  });
});
