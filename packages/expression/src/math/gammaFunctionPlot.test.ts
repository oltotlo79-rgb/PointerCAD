import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { createScalarDifferential } from './scalarDifferential.js';
import { GAMMA_FUNCTION_REFERENCES } from './gammaFunctionReferences.js';
import { POLYGAMMA_REFERENCES } from './polygammaReferences.js';
import type { MathInterval } from './mathInterval.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function tape(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return compileFunctionScalar(createFunctionMathSource(source, 'text', angleUnit,
    { axes: ['X'], parameters: [], coefficients: [] }, backend), ['X'], [], { backend, shouldStop: () => undefined });
}
function contains(range: MathInterval | null, expected: number): void {
  expect(range).not.toBeNull(); if (range === null) throw new Error('Missing enclosure');
  expect(range.lower).toBeLessThanOrEqual(expected); expect(range.upper).toBeGreaterThanOrEqual(expected);
}
const references = GAMMA_FUNCTION_REFERENCES.filter(([, value, first, second]) =>
  [value, first, second].every(text => Number.isFinite(Number(text)) && Number(text) !== 0));

describe('Gammaの作図・点の微分・式の微分を同じ原式の領域へ接続する', () => {
  it.each(references)('Gamma(%s)の値と二種類の微分経路を独立な数値で照合する', (input, value, first, second) => {
    const compiled = tape('gamma(X)'), x = Number(input), sample = createScalarSampler(compiled)([x]);
    expect(Math.abs(sample/Number(value)-1)).toBeLessThan(5e-11);
    const differential = createScalarDifferential(compiled)([x]);
    expect(differential.reason).toBeNull();
    expect(Math.abs((differential.gradient?.[0] ?? NaN)/Number(first)-1)).toBeLessThan(5e-10);
    const jet = createScalarDirectionalJet(compiled, [1])([{ lower: x, upper: x }]);
    contains(jet.first, Number(first)); contains(jet.second, Number(second));
  });
  it.each([0,1,2,7,15])('%s階のpolygammaにも一階・二階の作図用微分を接続する', order => {
    const x = 3.25, reference = (n: number) => {
      const item = POLYGAMMA_REFERENCES.find(([degree, input]) => degree === n && input === String(x));
      if (item === undefined) throw new Error('Missing independent reference');
      return Number(item[2]);
    };
    const compiled = tape(`polygamma(${order},X)`), jet = createScalarDirectionalJet(compiled, [1])([{ lower: x, upper: x }]);
    expect(Math.abs(createScalarSampler(compiled)([x])/reference(order)-1)).toBeLessThan(5e-11);
    contains(jet.first, reference(order+1)); contains(jet.second, reference(order+2));
    const point = createScalarDifferential(compiled)([x]);
    expect(point.reason).toBeNull(); expect(Math.abs((point.gradient?.[0] ?? NaN)/reference(order+1)-1)).toBeLessThan(5e-11);
  });
  it('式としての微分、合成の微分、角度の意味を保持する', () => {
    const gammaAtOne = references.find(([input]) => input === '1');
    if (gammaAtOne === undefined) throw new Error('Missing Gamma(1) reference');
    expect(createScalarSampler(tape('diff(gamma(X),X)'))([1])).toBeCloseTo(Number(gammaAtOne[2]), 10);
    expect(createScalarSampler(tape('diff(gamma(X),X,X)'))([1])).toBeCloseTo(Number(gammaAtOne[3]), 10);
    expect(createScalarSampler(tape('diff(gamma(X^2),X)'))([1])).toBeCloseTo(2*Number(gammaAtOne[2]), 10);
    const derivative = tape('diff(gamma(X),X)'), jet = createScalarDirectionalJet(derivative, [1])([{ lower: 1, upper: 1 }]);
    contains(jet.first, Number(gammaAtOne[3]));
    expect(createScalarSampler(tape('gamma(sin(X))', 'degree'))([30])).toBeCloseTo(Math.sqrt(Math.PI), 10);
  });
  it('定数のGammaと微分値を丸めた単点ではなく範囲で保持する', () => {
    for (const source of ['gamma(0.5)+X', 'polygamma(1,1)+X']) {
      const compiled = tape(source), sample = createScalarSampler(compiled)([0]);
      const range = createScalarIntervalSampler(compiled)([{ lower: 0, upper: 0 }]);
      expect(range.continuous).toBe(true); expect(range.ranges).toHaveLength(1);
      contains(range.ranges[0], sample);
    }
  });
  it.each(['gamma(X)', '0*gamma(X)', 'gamma(X)/gamma(X)', 'diff(gamma(X),X)',
    'diff(0*gamma(X),X)', 'polygamma(0,X)', 'diff(polygamma(1,X),X)'])(
    '%sから元の極を消さない', source => {
      const compiled = tape(source), sample = createScalarSampler(compiled), interval = createScalarIntervalSampler(compiled);
      for (const pole of [0,-1,-2]) {
        expect(Number.isFinite(sample([pole]))).toBe(false);
        expect(interval([{ lower: pole-0.1, upper: pole+0.1 }]).continuous).toBe(false);
      }
    });
  it('合成の内側の穴と、上限を超える微分を捏造しない', () => {
    for (const source of ['gamma(1/X)', 'diff(gamma(1/X),X)']) {
      const compiled = tape(source);
      expect(Number.isFinite(createScalarSampler(compiled)([0]))).toBe(false);
      expect(createScalarIntervalSampler(compiled)([{ lower: -1, upper: 1 }]).continuous).toBe(false);
    }
    expect(() => tape('polygamma(X,2)')).toThrow();
    expect(() => tape('diff(polygamma(17,X),X)')).toThrow('次数を上限内');
  });
});
