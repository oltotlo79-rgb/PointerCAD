import { beforeAll, describe, expect, it } from 'vitest';
import { hyperbolicRange, type HyperbolicOperation } from './hyperbolicIntervals.js';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { sampleFunctionCurve } from './adaptiveFunctionCurve.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const context = () => ({ backend, shouldStop: () => undefined });
const scope = { axes: ['X'] as const, parameters: [], coefficients: [] };
const definition = (source: string) => createFunctionMathSource(source, 'text', 'radian', scope, backend);
const tape = (source: string) => compileFunctionScalar(definition(source), ['X'], [], context());

describe('双曲線関数の値域と曲率を確認し、曲線の全区間を作図する', () => {
  it.each<readonly [HyperbolicOperation, number, number, (x: number) => number]>([
    ['sinh', -3, 2, Math.sinh], ['cosh', -3, 2, Math.cosh], ['tanh', -3, 2, Math.tanh],
    ['arsinh', -3, 2, Math.asinh], ['arcosh', 1, 4, Math.acosh], ['artanh', -0.8, 0.7, Math.atanh],
  ])('%sの全区間を囲み、狭い区間では有限の幅へ絞る', (operation, lower, upper, evaluate) => {
    const bounds = hyperbolicRange(operation, { lower, upper });
    if (bounds === null) throw new Error('Missing interval');
    for (let index = 0; index <= 40; index++) {
      const x = lower + (upper-lower)*index/40;
      expect(evaluate(x)).toBeGreaterThanOrEqual(bounds.lower);
      expect(evaluate(x)).toBeLessThanOrEqual(bounds.upper);
      const local = hyperbolicRange(operation, { lower: x, upper: x });
      if (local === null) throw new Error('Missing point interval');
      expect(evaluate(x)).toBeGreaterThanOrEqual(local.lower);
      expect(evaluate(x)).toBeLessThanOrEqual(local.upper);
      expect(local.upper-local.lower).toBeLessThan(1e-10);
    }
  });
  it('有理数の既知値・対称性・ゼロの最小値を別の式で確認する', () => {
    expect(hyperbolicRange('cosh', { lower: -1, upper: 2 })?.lower).toBe(1);
    for (const operation of ['sinh', 'tanh', 'arsinh', 'artanh'] as const) {
      expect(hyperbolicRange(operation, { lower: 0, upper: 0 })).toEqual({ lower: 0, upper: 0 });
    }
    // tanh(ln(2))=3/5, cosh(ln(2))=5/4, sinh(ln(2))=3/4.
    const ln2 = { lower: 0.6931471805599453, upper: 0.6931471805599454 };
    for (const [operation, exact] of [['tanh', 0.6], ['cosh', 1.25], ['sinh', 0.75]] as const) {
      const bounds = hyperbolicRange(operation, ln2);
      expect(bounds?.lower).toBeLessThanOrEqual(exact); expect(bounds?.upper).toBeGreaterThanOrEqual(exact);
    }
  });
  it('大きい有限入力の逆関数とtanhで不要な指数のあふれを作らない', () => {
    for (const operation of ['arsinh', 'arcosh'] as const) {
      const bounds = hyperbolicRange(operation, { lower: 1e200, upper: 1e200 });
      if (bounds === null) throw new Error('Missing large-input range');
      const expected = Math.log(2)+200*Math.LN10;
      expect(bounds.lower).toBeLessThanOrEqual(expected); expect(bounds.upper).toBeGreaterThanOrEqual(expected);
      expect(bounds.upper-bounds.lower).toBeLessThan(1e-8);
    }
    const saturated = hyperbolicRange('tanh', { lower: 1000, upper: 2000 });
    expect(saturated?.upper).toBe(1); expect(saturated?.lower).toBeGreaterThan(0.9999999999);
    expect(hyperbolicRange('sinh', { lower: NaN, upper: 1 })).toBeNull();
    expect(hyperbolicRange('cosh', { lower: 2, upper: 1 })).toBeNull();
  });
  it.each([
    ['coth(X)', 2, 1/Math.tanh(2)], ['sech(X)', -2, 1/Math.cosh(2)], ['csch(X)', -2, -1/Math.sinh(2)],
    ['acoth(X)', -2, -0.5*Math.log(3)], ['asech(X)', 0.5, Math.log(2+Math.sqrt(3))],
    ['acsch(X)', -0.5, -Math.log(2+Math.sqrt(5))],
    ['diff(coth(X),X)', 2, -1/Math.sinh(2)**2], ['diff(sech(X),X)', 2, -Math.tanh(2)/Math.cosh(2)],
    ['diff(csch(X),X)', -2, -Math.cosh(2)/Math.sinh(2)**2], ['diff(acoth(X),X)', -2, -1/3],
    ['diff(asech(X),X)', 0.5, -4/Math.sqrt(3)], ['diff(acsch(X),X)', -0.5, -4/Math.sqrt(5)],
  ])('%sを既知の実数の枝と同じ導関数で作図へ渡す', (source, x, expected) => {
    const compiled = tape(source);
    expect(createScalarSampler(compiled)([x])).toBeCloseTo(expected, 11);
    const bound = createScalarIntervalSampler(compiled)([{ lower: x, upper: x }]);
    expect(bound.continuous).toBe(true);
    expect(bound.ranges.some(range => range.lower <= expected && expected <= range.upper)).toBe(true);
  });
  it.each([
    ['sinh(X)', 0.5, Math.cosh(0.5), Math.sinh(0.5)],
    ['cosh(X)', 0.5, Math.sinh(0.5), Math.cosh(0.5)],
    ['tanh(X)', 0.5, 1/Math.cosh(0.5)**2, -2*Math.tanh(0.5)/Math.cosh(0.5)**2],
    ['asinh(X)', 2, 1/Math.sqrt(5), -2/(5*Math.sqrt(5))],
    ['acosh(X)', 2, 1/Math.sqrt(3), -2/(3*Math.sqrt(3))],
    ['atanh(X)', 0.5, 4/3, 16/9],
  ])('%sの一階・二階微分が独立した解析値を含む', (source, x, first, second) => {
    const derivative = createScalarDirectionalJet(tape(source), [1])([{ lower: x-0.001, upper: x+0.001 }]);
    expect(derivative.first?.lower).toBeLessThanOrEqual(first); expect(derivative.first?.upper).toBeGreaterThanOrEqual(first);
    expect(derivative.second?.lower).toBeLessThanOrEqual(second); expect(derivative.second?.upper).toBeGreaterThanOrEqual(second);
    expect(Number.isFinite(derivative.second?.upper)).toBe(true);
  });
  it.each(['csch(X)', 'coth(X)', 'acsch(X)', 'acoth(X)', 'asech(X)', '0*csch(X)'])(
    '%sの極・定義域の外をゼロや連続した区間へ置き換えない', source => {
      const compiled = tape(source);
      expect(Number.isNaN(createScalarSampler(compiled)([0]))).toBe(true);
      expect(createScalarIntervalSampler(compiled)([{ lower: -0.1, upper: 0.1 }]).continuous).toBe(false);
    });
  it('coshの曲線を誤差以内で作り、中央と各線分の内部を確認する', () => {
    const sources = ['X', 'cosh(X)', '0'].map(definition);
    const evaluator = createFunctionCurveEvaluator([sources[0], sources[1], sources[2]], 'X', [], context());
    const result = sampleFunctionCurve(evaluator, { lower: -2, upper: 2, minimum: [-2, 0, -1], maximum: [2, 4, 1],
      tolerance: 0.001, maximumSamples: 2000, maximumCells: 4000, maximumDepth: 30 });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components).toHaveLength(1);
    const points = result.components[0];
    expect(points[0].point[0]).toBe(-2); expect(points.at(-1)?.point[0]).toBe(2);
    for (let index = 1; index < points.length; index++) {
      const a = points[index-1].point, b = points[index].point;
      for (const fraction of [0.25, 0.5, 0.75]) {
        const x = a[0]+fraction*(b[0]-a[0]), y = a[1]+fraction*(b[1]-a[1]);
        expect(Math.abs(y-Math.cosh(x))).toBeLessThanOrEqual(0.001);
      }
    }
    expect(sources[1].source).toBe('cosh(X)');
  });
});
