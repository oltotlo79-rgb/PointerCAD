import { beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { createScalarDifferential } from './scalarDifferential.js';
import { BESSEL_INTEGER_REFERENCES } from './besselIntegerReferences.js';
import { BESSEL_SECOND_REFERENCES } from './besselSecondKindReferences.js';
import type { MathInterval } from './mathInterval.js';
import { exactDouble } from './exactDoubleInterval.js';

const D = Decimal.clone({ precision: 300 });

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function tape(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return compileFunctionScalar(createFunctionMathSource(source, 'text', angleUnit,
    { axes: ['X'], parameters: [], coefficients: [] }, backend), ['X'], [], { backend, shouldStop: () => undefined });
}
function contains(range: MathInterval | null, expected: string): void {
  expect(range).not.toBeNull(); if (range === null) throw new Error('Missing enclosure');
  const exact = (value: number) => {
    const rational = exactDouble(value); if (rational === null) throw new Error('Non-finite enclosure');
    return new D(rational.numerator.toString()).div(rational.denominator.toString());
  };
  expect(exact(range.lower).lte(expected)).toBe(true); expect(exact(range.upper).gte(expected)).toBe(true);
}
const references = [...BESSEL_INTEGER_REFERENCES, ...BESSEL_SECOND_REFERENCES]
  .filter(([, , x, ...values]) => ['0', '1', '3', '128', '0.125'].includes(x) && values.every(text => Number.isFinite(Number(text))));

describe('四種類のBesselを値・点の微分・範囲の微分へ一貫して接続する', () => {
  it.each(references)('%s_%s(%s)の値と微分を独立基準へ照合する', (kind, n, x, v, d1, d2) => {
    const compiled = tape(`bessel${kind.toLowerCase()}(${n},X)`), input = Number(x);
    const close = (actual: number, text: string) => {
      const expected = Number(text);
      if (expected === 0) expect(actual).toBe(0); else expect(Math.abs(actual/expected-1)).toBeLessThan(5e-11);
    };
    const sampled = createScalarSampler(compiled)([input]);
    const differential = createScalarDifferential(compiled)([input]);
    if (!new D(v).isZero() && Number(v) === 0) {
      expect(Number.isNaN(sampled)).toBe(true);
      expect(differential).toMatchObject({ gradient: null, reason: 'domain' });
    } else {
      close(sampled, v);
      expect(differential.reason).toBeNull(); close(differential.gradient?.[0] ?? NaN, d1);
    }
    const jet = createScalarDirectionalJet(compiled, [1])([{ lower: input, upper: input }]);
    contains(jet.first, d1); contains(jet.second, d2);
  });
  it.each(['j', 'y', 'i', 'k'])('%sの式の微分・合成の微分・定数の範囲を保持する', kind => {
    const reference = references.find(([family, n, x]) => family.toLowerCase() === kind && n === 0 && x === '1');
    if (reference === undefined) throw new Error('Missing independent Bessel reference');
    expect(createScalarSampler(tape(`diff(bessel${kind}(0,X),X)`))([1])).toBeCloseTo(Number(reference[4]), 12);
    expect(createScalarSampler(tape(`diff(bessel${kind}(0,X),X,X)`))([1])).toBeCloseTo(Number(reference[5]), 12);
    expect(createScalarSampler(tape(`diff(bessel${kind}(0,X^2),X)`))([1])).toBeCloseTo(2*Number(reference[4]), 12);
    const constant = tape(`bessel${kind}(0,1)+X`), range = createScalarIntervalSampler(constant)([{ lower: 0, upper: 0 }]);
    expect(range.continuous).toBe(true); expect(range.ranges).toHaveLength(1); contains(range.ranges[0], reference[3]);
  });
  it.each(['bessely(0,X)', '0*besselk(0,X)', 'bessely(1,X)/bessely(1,X)', 'diff(0*besselk(0,X),X)',
    'besselj(0,1/X)', 'diff(besseli(0,1/X),X)'])(
    '%sの元の穴を0倍・約分・微分で消さない', source => {
      const compiled = tape(source);
      expect(Number.isFinite(createScalarSampler(compiled)([0]))).toBe(false);
      expect(createScalarIntervalSampler(compiled)([{ lower: -0.1, upper: 0.1 }]).continuous).toBe(false);
    });
  it('次数を変数にせず、式の微分の範囲外を捏造しない', () => {
    expect(() => tape('besselj(X,1)')).toThrow('整数');
    expect(() => tape('diff(besselj(128,X),X)')).toThrow('生成される次数');
    expect(() => tape('diff(besselk(-128,X),X)')).toThrow('生成される次数');
    expect(createScalarSampler(tape('diff(besselj(0,X),X)'))([0])).toBe(0);
    expect(createScalarSampler(tape('diff(besseli(0,X),X,X)'))([0])).toBe(0.5);
  });
});
