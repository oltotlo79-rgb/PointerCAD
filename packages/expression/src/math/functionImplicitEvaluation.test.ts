import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionImplicitEvaluator } from './functionImplicitEvaluation.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function equation(source: string, angleUnit: 'radian' | 'degree' = 'radian') {
  const definition = createFunctionMathSource(source, 'text', angleUnit, { axes:['X','Y','Z'], parameters:[], coefficients:[] }, backend);
  return createFunctionImplicitEvaluator(definition, [], { backend, shouldStop: () => undefined });
}
describe('空間等式と陰関数の共有評価', () => {
  it('球の残差・区間・微分を独立した解析値と照合する', () => {
    const f = equation('X^2+Y^2+Z^2-4');
    expect(f.point([0,0,2])).toBe(0);
    expect(f.gradient([1,2,3]).gradient).toEqual([2,4,6]);
    const derivatives = f.partials([1,2,3], [2,3,4]);
    for (let axis = 0; axis < 3; axis++) {
      expect(derivatives[axis]?.lower).toBeLessThanOrEqual(2*(axis+1));
      expect(derivatives[axis]?.upper).toBeGreaterThanOrEqual(2*(axis+2));
    }
    const bounds = f.enclosure([-1,-1,-1],[1,1,1]);
    expect(bounds.continuous).toBe(true); expect(bounds.ranges[0].upper).toBeLessThan(0);
  });
  it('角度単位が区間の1階微分にも適用される', () => {
    const derivative = equation('sin(X)+Y+Z', 'degree').partials([0,0,0], [30,1,1])[0];
    expect(derivative?.lower).toBeLessThanOrEqual(Math.cos(Math.PI/6)*Math.PI/180);
    expect(derivative?.upper).toBeGreaterThanOrEqual(Math.PI/180);
    expect(derivative?.upper).toBeLessThan(0.018);
  });
  it('不連続を跨ぐ領域は微分の保証を返さず、任意方向の微分は同じ式から求める', () => {
    const f = equation('1/X+Y+Z');
    expect(f.enclosure([-1,0,0],[1,1,1]).continuous).toBe(false);
    expect(f.partials([-1,0,0],[1,1,1])).toEqual([null,null,null]);
    const derivative = equation('X^2+Y*Z').along([1,2,-1])([1,2,3], [1,2,3]);
    expect(derivative?.lower).toBeLessThanOrEqual(6); expect(derivative?.upper).toBeGreaterThanOrEqual(6);
  });
});
