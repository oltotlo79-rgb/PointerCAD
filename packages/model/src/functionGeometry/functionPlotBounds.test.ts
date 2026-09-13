import { describe, expect, it } from 'vitest';
import { FUNCTION_PLOT_AXES, FunctionPlotBounds, type FunctionPlotBoundsData } from './functionPlotBounds.js';

const box = (): FunctionPlotBoundsData => ({ X: { min: -10, max: 10 }, Y: { min: -20, max: 20 }, Z: { min: -1, max: 1 } });
const invalidOrders = FUNCTION_PLOT_AXES.flatMap(axis => [{ axis, min: 0, max: 0 }, { axis, min: 2, max: -2 }]);

describe('関数作図の必須XYZ範囲（FR-334/436）', () => {
  it.each(FUNCTION_PLOT_AXES)('%sを省略できず、媒介変数や固定座標で代用できない', axis => {
    const input: Record<string, unknown> = { ...box(), T: { min: 0, max: 1 }, fixedZ: 0 };
    delete input[axis];
    expect(FunctionPlotBounds.read(input)).toEqual({ ok: false, issues: [
      { axis, field: 'min', reason: 'required' }, { axis, field: 'max', reason: 'required' },
    ] });
  });

  it.each(FUNCTION_PLOT_AXES.flatMap(axis => (['min', 'max'] as const).map(field => ({ axis, field }))))(
    '$axis.$fieldの欠落は既定の無限範囲へ補完しない', ({ axis, field }) => {
      const interval: Record<string, unknown> = { ...box()[axis] };
      delete interval[field];
      expect(FunctionPlotBounds.read({ ...box(), [axis]: interval })).toEqual({ ok: false, issues: [{ axis, field, reason: 'required' }] });
    });

  it.each([NaN, Infinity, -Infinity, '10', { real: 1, imaginary: 1 }, true])(
    '有限実数へ評価されていない%sを受理しない', value => {
      expect(FunctionPlotBounds.read({ ...box(), Y: { min: -20, max: value } })).toEqual({ ok: false,
        issues: [{ axis: 'Y', field: 'max', reason: 'not-finite-real' }] });
    });

  it.each(invalidOrders)(
    '$axisで同値または逆転した$min/$maxを拒否する', ({ axis, min, max }) => {
      expect(FunctionPlotBounds.read({ ...box(), [axis]: { min, max } })).toEqual({ ok: false,
        issues: [{ axis, field: 'range', reason: 'order' }] });
    });

  it('有限の両端でもdoubleで幅を表現できなければ理由を返す', () => {
    expect(FunctionPlotBounds.read({ ...box(), X: { min: -1e308, max: 1e308 } })).toEqual({ ok: false,
      issues: [{ axis: 'X', field: 'range', reason: 'unrepresentable-span' }] });
  });

  it('固定Z=0の平面も有限なZ範囲を持ち、6境界を含む', () => {
    const result = FunctionPlotBounds.read(box());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const point of [[0, 0, 0], [-10, -20, -1], [10, 20, 1]] as const) expect(result.bounds.contains(point)).toBe(true);
    for (const point of [[-11, 0, 0], [11, 0, 0], [0, -21, 0], [0, 21, 0], [0, 0, -2], [0, 0, 2], [NaN, 0, 0]] as const) {
      expect(result.bounds.contains(point)).toBe(false);
    }
  });

  it('入力を後から変更しても検証済み範囲は変化せず、転送後は再検証する', () => {
    const input = { X: { min: -1, max: 1 }, Y: { min: -2, max: 2 }, Z: { min: -3, max: 3 } };
    const result = FunctionPlotBounds.read(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    input.X.max = Infinity;
    expect(result.bounds.interval('X')).toEqual({ min: -1, max: 1 });
    expect(Object.isFrozen(result.bounds)).toBe(true);
    expect(Object.isFrozen(result.bounds.toJSON())).toBe(true);
    expect(Object.isFrozen(result.bounds.interval('X'))).toBe(true);
    const restored = FunctionPlotBounds.read(JSON.parse(JSON.stringify(result.bounds)));
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.bounds.toJSON()).toEqual({ X: { min: -1, max: 1 }, Y: { min: -2, max: 2 }, Z: { min: -3, max: 3 } });
  });
});
