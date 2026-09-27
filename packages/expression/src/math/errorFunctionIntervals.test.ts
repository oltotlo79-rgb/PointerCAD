import { describe, expect, it } from 'vitest';
import { errorFunctionRange, errorFunctionSample, errorFunctionDerivative } from './errorFunctionIntervals.js';
import { ERROR_FUNCTION_REFERENCES } from './errorFunctionReferences.js';
import type { MathInterval } from './mathInterval.js';

function contains(range: MathInterval | null, expected: number): void {
  if (range === null) throw new Error('Missing enclosure');
  expect(range.lower).toBeLessThanOrEqual(expected);
  expect(range.upper).toBeGreaterThanOrEqual(expected);
}
describe('誤差関数の区間は有限和の残差と連分数の挟み込みを含む', () => {
  it.each(ERROR_FUNCTION_REFERENCES)('引数$xで別の90桁計算を包含し、裾を大きな固定幅に置換しない', row => {
    const x = Number(row.x);
    for (const id of ['erf', 'erfc'] as const) {
      const expected = Number(row[id]), range = errorFunctionRange(id, { lower: x, upper: x });
      contains(range, expected);
      if (range === null) throw new Error('Missing enclosure');
      expect(errorFunctionSample(id, x)).toBeGreaterThanOrEqual(range.lower);
      expect(errorFunctionSample(id, x)).toBeLessThanOrEqual(range.upper);
      if (expected === 0) expect(range).toEqual({ lower: 0, upper: 0 });
      else expect((range.upper-range.lower)/Math.abs(expected)).toBeLessThan(2e-10);
    }
  });
  it('両側の符号をまたぐ範囲全体を単調性で包み、補関数では端点の向きを逆にする', () => {
    for (const id of ['erf', 'erfc'] as const) {
      const range = errorFunctionRange(id, { lower: -4, upper: 4 });
      for (const row of ERROR_FUNCTION_REFERENCES.filter(row => Math.abs(Number(row.x)) <= 4)) contains(range, Number(row[id]));
    }
    expect(errorFunctionRange('erf', { lower: 0, upper: 0 })).toEqual({ lower: 0, upper: 0 });
    expect(errorFunctionRange('erfc', { lower: 0, upper: 0 })).toEqual({ lower: 1, upper: 1 });
  });
  it('微分の全範囲を元の指数関数の独立な値で照合する', () => {
    for (const id of ['erf', 'erfc'] as const) for (const [a,b] of [[-4,-2],[-1,1],[2,4]]) {
      const slope = errorFunctionDerivative(id, { lower: a, upper: b });
      for (let i=0;i<=20;i++) {
        const x = a+(b-a)*i/20;
        contains(slope, (id === 'erf' ? 1 : -1)*2/Math.sqrt(Math.PI)*Math.exp(-x*x));
      }
    }
  });
  it('不正な範囲と予算外は不明のまま、表現できない裾は0を返さない', () => {
    for (const interval of [{ lower: 1, upper: 0 }, { lower: NaN, upper: 1 }, { lower: 0, upper: Infinity }, { lower: 0, upper: 500001 }]) {
      expect(errorFunctionRange('erf', interval)).toBeNull();
    }
    expect(Number.isFinite(errorFunctionSample('erfc', 50))).toBe(false);
  });
});
