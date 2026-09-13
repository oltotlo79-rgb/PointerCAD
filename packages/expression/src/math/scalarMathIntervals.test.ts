import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { rationalOfExpression } from './exactRational.js';
import { compileScalarMath, createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { intervalUnion, unionOutsideBounds } from './mathIntervalUnion.js';
import { intervalAdd, intervalSubtract } from './mathInterval.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function samples(source: string, angleUnit: 'radian' | 'degree' = 'radian') {
  const expression = createFunctionMathSource(source, 'text', angleUnit, { axes: ['X'], parameters: [], coefficients: [] }, backend);
  const tape = compileScalarMath(expression.expression, { inputs: ['X'], angleUnit, evaluateConstant: node => {
    if (node.kind === 'constant' && node.name === 'pi') return Math.PI;
    const rational = rationalOfExpression(node);
    if (rational === null) throw new Error('Expected rational fixture constant');
    return Number(rational.numerator) / Number(rational.denominator);
  } });
  return { range: createScalarIntervalSampler(tape), point: createScalarSampler(tape) };
}

describe('同じ計算計画から曲線の区間・極・定義域を判定する', () => {
  it.each([
    { lower: 0, upper: 0 }, { lower: Number.MIN_VALUE, upper: Number.MIN_VALUE },
    { lower: -3, upper: 7 }, { lower: Number.MAX_VALUE, upper: Number.MAX_VALUE },
    { lower: -Infinity, upper: Infinity },
  ])('厳密な0の加減算は既に証明した区間$lower〜$upperを広げない', interval => {
    const zero = { lower: 0, upper: 0 }, expected = { status: 'range', interval };
    expect(intervalAdd(zero, interval)).toEqual(expected);
    expect(intervalAdd(interval, zero)).toEqual(expected);
    expect(intervalSubtract(interval, zero)).toEqual(expected);
  });
  it('0以外の加算の丸め幅と、0を加える前に存在した極を保つ', () => {
    const sum = intervalAdd({ lower: 0.1, upper: 0.1 }, { lower: 0.2, upper: 0.2 });
    expect(sum.status).toBe('range');
    if (sum.status !== 'range') throw new Error(sum.status);
    expect(sum.interval.lower).toBeLessThanOrEqual(0.3);
    expect(sum.interval.upper).toBeGreaterThan(0.1 + 0.2);
    const negated = intervalSubtract({ lower: 0, upper: 0 }, { lower: -3, upper: 7 });
    expect(negated).toEqual({ status: 'range', interval: { lower: -7, upper: 3 } });
    expect(samples('0+1/X').range([{ lower: -1, upper: 1 }]).continuous).toBe(false);
  });

  it('1/Xの極の周囲を2つの値域として保ち、XYZの範囲外を証明して除外する', () => {
    const sample = samples('1/X'), result = sample.range([{ lower: -0.01, upper: 0.01 }]);
    expect(result.continuous).toBe(false); expect(result.ranges).toHaveLength(2);
    expect(result.ranges[0].upper).toBeLessThan(-99.9); expect(result.ranges[1].lower).toBeGreaterThan(99.9);
    expect(unionOutsideBounds([intervalUnion(-0.01, 0.01), result, intervalUnion(0)], [-1, -10, -1], [1, 10, 1])).toBe(true);
    expect(sample.point([0])).toBeNaN();
  });

  it.each(['X^2+2*X+1', '1/(X+3)', 'abs(X)', 'sqrt(X+3)', 'sin(X^2)', 'cos(X)', 'ln(X+3)'])('%sの区間が独立した内部評価値を包む', source => {
    const sample = samples(source), result = sample.range([{ lower: -1, upper: 1 }]);
    expect(result.continuous).toBe(true);
    for (let index = 0; index <= 40; index++) {
      const value = sample.point([-1 + index / 20]);
      expect(Number.isFinite(value)).toBe(true);
      expect(result.ranges.some(range => value >= range.lower && value <= range.upper)).toBe(true);
    }
  });

  it('0倍や絶対値を重ねても、元の極を連続な式へ変えない', () => {
    const multiplied = samples('0*(1/X)').range([{ lower: -1, upper: 1 }]);
    const absolute = samples('abs(1/X)').range([{ lower: -1, upper: 1 }]);
    expect(multiplied.continuous).toBe(false); expect(absolute.continuous).toBe(false);
  });

  it('負数の平方根・対数は空、境界を跨ぐ区間は分割が必要とする', () => {
    const sqrt = samples('sqrt(X)'), log = samples('ln(X)');
    expect(sqrt.range([{ lower: -2, upper: -1 }]).ranges).toEqual([]);
    expect(log.range([{ lower: -2, upper: -1 }]).ranges).toEqual([]);
    expect(sqrt.range([{ lower: -1, upper: 1 }]).continuous).toBe(false);
    expect(log.range([{ lower: -1, upper: 1 }]).continuous).toBe(false);
  });
  it('対数の定義域境界を含む狭い区間でもXYZの外側を証明して除外する', () => {
    const log = samples('ln(X)'), range = log.range([{ lower: -0.001, upper: 0.001 }]);
    expect(range.continuous).toBe(false); expect(range.ranges).toHaveLength(1);
    expect(range.ranges[0].lower).toBe(-Infinity); expect(range.ranges[0].upper).toBeLessThan(-6.9);
    expect(unionOutsideBounds([intervalUnion(-0.001, 0.001), range, intervalUnion(0)],
      [-2, -5, -1], [2, 5, 1])).toBe(true);
    expect(samples('0*ln(X)').range([{ lower: -1, upper: 1 }]).continuous).toBe(false);
  });

  it('丸めると2になる非整数の指数を、負数の整数冪として扱わない', () => {
    const sample = samples('X^(2000000000000000000000000000001/1000000000000000000000000000000)');
    expect(sample.point([-1])).toBeNaN();
    expect(sample.range([{ lower: -2, upper: -1 }]).ranges).toEqual([]);
  });

  it('整数の負の冪の極と0^0を埋めず、階段状の関数を連続扱いしない', () => {
    expect(samples('X^(-2)').range([{ lower: -1, upper: 1 }]).continuous).toBe(false);
    expect(samples('X^0').range([{ lower: -1, upper: 1 }]).continuous).toBe(false);
    expect(samples('floor(X)').range([{ lower: 0.5, upper: 1.5 }]).continuous).toBe(false);
    expect(samples('floor(X)').range([{ lower: 0.2, upper: 0.8 }])).toEqual(intervalUnion(0));
  });

  it('未検証の三角関数の極や不正入力を、有限な標本だけで安全と判定しない', () => {
    const sample = samples('tan(X)');
    expect(sample.range([{ lower: 1, upper: 2 }]).continuous).toBe(false);
    expect(sample.range([{ lower: NaN, upper: 2 }]).continuous).toBe(false);
    expect(sample.range([]).continuous).toBe(false);
  });
  it.each([
    { source: 'tan(X)', pole: Math.PI/2 }, { source: 'cot(X)', pole: 0 },
    { source: 'sec(X)', pole: Math.PI/2 }, { source: 'csc(X)', pole: 0 },
  ])('$sourceの極を挟む2つの値域が有限XYZ箱の外だと判定できる', ({ source, pole }) => {
    const result = samples(source).range([{ lower: pole-0.001, upper: pole+0.001 }]);
    expect(result.continuous).toBe(false); expect(result.ranges).toHaveLength(2);
    expect(result.ranges[0].upper).toBeLessThan(-900); expect(result.ranges[1].lower).toBeGreaterThan(900);
    expect(unionOutsideBounds([intervalUnion(pole-0.001, pole+0.001), result, intervalUnion(0)],
      [-2, -5, -1], [2, 5, 1])).toBe(true);
  });
  it.each(['tan(X)', 'cot(X)', 'sec(X)', 'csc(X)'])('%sの極から離れた区間は連続で内部値を包む', source => {
    const sample = samples(source), result = sample.range([{ lower: 0.4, upper: 0.6 }]);
    expect(result.continuous).toBe(true); expect(result.ranges).toHaveLength(1);
    for (let index = 0; index <= 40; index++) {
      const value = sample.point([0.4+0.2*index/40]);
      expect(value).toBeGreaterThanOrEqual(result.ranges[0].lower);
      expect(value).toBeLessThanOrEqual(result.ranges[0].upper);
    }
  });
  it('度数の極を巨大な有限値に置換せず、0倍でも未定義を残す', () => {
    for (const source of ['tan(X)', 'sec(X)', '0*tan(X)']) {
      const sample = samples(source, 'degree');
      expect(sample.point([90])).toBeNaN();
      expect(sample.range([{ lower: 89, upper: 91 }]).continuous).toBe(false);
    }
    expect(samples('cot(X)', 'degree').point([180])).toBeNaN();
    expect(samples('csc(X)', 'degree').point([360])).toBeNaN();
  });
});
