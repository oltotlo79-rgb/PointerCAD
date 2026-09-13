import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarDirectionalCurvature } from './scalarCurveCurvature.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function tape(source: string) {
  return compileFunctionScalar(createFunctionMathSource(source, 'text', 'radian',
    { axes: ['X', 'Y'], parameters: [], coefficients: [] }, backend), ['X', 'Y'], [], { backend, shouldStop: () => undefined });
}
const box = [{ lower: -1, upper: 1 }, { lower: -0.5, upper: 0.5 }];
describe('曲面の各軸と混合方向に同じ区間自動微分を使用する', () => {
  it.each([[1,0], [0,1], [1,1], [1,-1], [2,3]])('二次形式の方向(%s,%s)が解析的なHessianと一致する', (u, v) => {
    const bound = createScalarDirectionalCurvature(tape('3*X^2+5*X*Y+7*Y^2'), [u,v])(box);
    const exact = Math.abs(6*u*u+10*u*v+14*v*v);
    expect(bound).not.toBeNull();
    if (bound === null) throw new Error('Expected finite curvature');
    expect(bound).toBeGreaterThanOrEqual(exact); expect(bound-exact).toBeLessThan(1e-9);
  });
  it('非線形な合成関数の方向微分を独立した解析式で確認する', () => {
    const bound = createScalarDirectionalCurvature(tape('sin(X*Y)'), [1,2])(box);
    if (bound === null) throw new Error('Expected finite curvature');
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
      const x = -1+i/6, y = -0.5+j/12;
      expect(Math.abs(-Math.sin(x*y)*(y+2*x)**2+4*Math.cos(x*y))).toBeLessThanOrEqual(bound);
    }
  });
  it('方向配列の後書換を取り込まず、不正な方向・区間を拒否する', () => {
    const compiled = tape('X^2'), direction = [1,0], evaluate = createScalarDirectionalCurvature(compiled, direction);
    direction[0] = 100;
    expect(evaluate(box)).toBeCloseTo(2, 10);
    expect(() => createScalarDirectionalCurvature(compiled, [NaN,0])).toThrow();
    expect(() => createScalarDirectionalCurvature(compiled, [1])).toThrow();
    expect(evaluate([{ lower: 0, upper: NaN }, box[1]])).toBeNull();
  });
});
