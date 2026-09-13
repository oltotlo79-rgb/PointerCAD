import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarDirectionalJet, createScalarFirstDerivatives } from './scalarCurveCurvature.js';
import * as arithmetic from './mathInterval.js';
import type { MathInterval } from './mathInterval.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

const calls = vi.hoisted(() => ({ intervals: 0 }));
vi.mock('./scalarMathIntervals.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./scalarMathIntervals.js')>();
  return { ...actual, createScalarIntervalEvaluation: (...args: Parameters<typeof actual.createScalarIntervalEvaluation>) => {
    const evaluation = actual.createScalarIntervalEvaluation(...args);
    return { ...evaluation, evaluate: (...inputs: Parameters<typeof evaluation.evaluate>) => {
      calls.intervals++; return evaluation.evaluate(...inputs);
    } };
  } };
});

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function tape(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return compileFunctionScalar(createFunctionMathSource(source, 'text', angleUnit,
    { axes: ['X', 'Y', 'Z'], parameters: [], coefficients: [] }, backend), ['X', 'Y', 'Z'], [], { backend, shouldStop: () => undefined });
}
const directions = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const boxes: readonly (readonly MathInterval[])[] = [
  [{ lower: 0.2, upper: 0.8 }, { lower: -0.5, upper: 0.5 }, { lower: 1, upper: 2 }],
  [{ lower: -1, upper: 1 }, { lower: 1, upper: 2 }, { lower: -2, upper: -1 }],
  [{ lower: -2, upper: -1 }, { lower: -1, upper: 0 }, { lower: 0, upper: 0 }],
];

describe('陰関数の一次微分は同じ値の区間を一度だけ評価する', () => {
  it.each(['1', 'X', '-X', 'X+Y+Z', 'X-Y', 'X*Y*Z', 'X/(Y+3)', '(X+3)^-3',
    'X^2', 'X^3', 'sqrt(X)', 'abs(X)', 'sin(X+Y)', 'cos(X)', 'tan(X)', 'cot(X)',
    'sec(X)', 'csc(X)', 'ln(X)', 'exp(X)', 'floor(X)', 'ceil(X)', 'sgn(X)',
    'min(X,Y)', 'atan(X)', '(X^2+Y^2+Z^2+4-0.25)^2-16*(X^2+Y^2)'])(
    '%sの全軸の一次微分が従来の二次までの評価と区間端点まで一致する', source => {
    for (const angle of ['degree', 'radian'] as const) {
      const compiled = tape(source, angle), evaluate = createScalarFirstDerivatives(compiled, directions);
      const reference = directions.map(direction => createScalarDirectionalJet(compiled, direction));
      for (const box of boxes) {
        const expected = reference.map(sample => sample(box).first);
        calls.intervals = 0;
        expect(evaluate(box)).toEqual(expected);
        expect(calls.intervals).toBe(1);
      }
    }
  });

  it('任意の混合方向とトーラスの独立な解析微分を包み、微小な非零を消さない', () => {
    const mixed = [[1, 2, -3], [-0.5, 0, 4], [0, 0, 0]];
    const compiled = tape('(X^2+Y^2+Z^2+4-0.25)^2-16*(X^2+Y^2)');
    const evaluate = createScalarFirstDerivatives(compiled, mixed);
    for (const point of [[2, 0, 0.5], [1.5, -0.25, -0.5], [1e-40, 0, 0]]) {
      const [x, y, z] = point, radius = x*x+y*y+z*z+3.75;
      const gradient = [4*x*(radius-8), 4*y*(radius-8), 4*z*radius];
      const actual = evaluate(point.map(value => ({ lower: value, upper: value })));
      for (const [index, direction] of mixed.entries()) {
        const interval = actual[index];
        if (interval === null) throw new Error('Expected a regular polynomial derivative');
        const expected = gradient.reduce((sum, value, axis) => sum + value*direction[axis], 0);
        expect(interval.lower).toBeLessThanOrEqual(expected);
        expect(interval.upper).toBeGreaterThanOrEqual(expected);
        if (expected !== 0) expect(interval.lower === 0 && interval.upper === 0).toBe(false);
      }
    }
  });

  it('方向と入力を書き換えても以前の結果を変えず、不正な区間を古い成功で代用しない', () => {
    const compiled = tape('X^2+Y^2+Z^2'), direction = [1, 0, 0];
    const evaluate = createScalarFirstDerivatives(compiled, [direction]);
    direction[0] = 100;
    const input = [{ lower: 1, upper: 1 }, { lower: 0, upper: 0 }, { lower: 0, upper: 0 }];
    const original = evaluate(input), copy = structuredClone(original);
    expect(original).toEqual([createScalarDirectionalJet(compiled, [1, 0, 0])(input).first]);
    input[0] = { lower: 2, upper: 2 };
    expect(evaluate(input)).not.toEqual(original);
    expect(original).toEqual(copy);
    expect(evaluate([{ lower: 0, upper: NaN }, input[1], input[2]])).toEqual([null]);
    expect(evaluate(input)).toEqual([createScalarDirectionalJet(compiled, [1, 0, 0])(input).first]);
    expect(() => createScalarFirstDerivatives(compiled, [])).toThrow();
    expect(() => createScalarFirstDerivatives(compiled, [...directions, [1, 1, 1]])).toThrow();
    expect(() => createScalarFirstDerivatives(compiled, [[NaN, 0, 0]])).toThrow();
    expect(() => createScalarFirstDerivatives(compiled, [[1]])).toThrow();
  });

  it('同じ1方向でも未使用の二次微分の掛け算を実行しない', () => {
    const compiled = tape('(X+3)*(Y+4)*(Z+5)'), direction = [1, 2, 3];
    const first = createScalarFirstDerivatives(compiled, [direction]);
    const second = createScalarDirectionalJet(compiled, direction);
    const multiply = vi.spyOn(arithmetic, 'intervalMultiply');
    try {
      const expected = second(boxes[0]).first, secondOrderCalls = multiply.mock.calls.length;
      multiply.mockClear();
      expect(first(boxes[0])).toEqual([expected]);
      expect(multiply.mock.calls.length).toBeLessThan(secondOrderCalls);
    } finally { multiply.mockRestore(); }
  });
});
