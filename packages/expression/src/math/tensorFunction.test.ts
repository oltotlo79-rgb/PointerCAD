import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { sampleFunctionCurve } from './adaptiveFunctionCurve.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'width', label: 'X', decimal: '3' }];
const scope = { axes: ['X'] as const, parameters: [], coefficients };
const definition = (source: string) => createFunctionMathSource(source, 'text', 'degree', scope, backend);
const context = () => ({ backend, shouldStop: () => undefined });

describe('テンソルの成分を関数の計算計画へ展開してから範囲付きで描く', () => {
  it('座標Xと係数Xを区別し、係数編集後も元の式と計算計画を壊さない', () => {
    const source = definition('tensorelement(tensorproduct([X,X^2],[coef("X"),2]),[2,1])');
    const original = JSON.stringify(source);
    let evaluations = 0;
    const counted: MathExecutionBackend = { ...backend, box(expression) { evaluations += 1; return backend.box(expression); } };
    const sampler = createScalarSampler(compileFunctionScalar(source, ['X'], coefficients,
      { backend: counted, shouldStop: () => undefined }));
    const preparedCount = evaluations;
    for (let index = 0; index <= 100; index += 1) {
      const x = (index - 50)/25;
      expect(sampler([x])).toBeCloseTo(3*x*x, 12);
    }
    expect(evaluations).toBe(preparedCount);
    const changed = createScalarSampler(compileFunctionScalar(source, ['X'], [{ ...coefficients[0], decimal: '5' }], context()));
    expect(changed([2])).toBe(20); expect(sampler([2])).toBe(12);
    expect(JSON.stringify(source)).toBe(original);
  });
  it('縮約した式の極を消さず、0をまたぐ区間は連続と扱わない', () => {
    const source = definition('tensorcontract([[1/X,0],[0,2]],1,2)');
    const tape = compileFunctionScalar(source, ['X'], coefficients, context());
    const interval = createScalarIntervalSampler(tape);
    expect(interval([{ lower: -1, upper: 1 }]).continuous).toBe(false);
    const positive = interval([{ lower: 1, upper: 2 }]);
    expect(positive.continuous).toBe(true);
    expect(positive.ranges[0].lower).toBeLessThanOrEqual(2.5);
    expect(positive.ranges[0].upper).toBeGreaterThanOrEqual(3);
  });
  it('抽出したX²を範囲の境界候補まで採取し、原式の精度でCADの切取りへ渡す', () => {
    const evaluator = createFunctionCurveEvaluator([
      definition('X'), definition('tensorelement(tensorproduct([X,X^2],[1,2]),[2,1])'), definition('0'),
    ], 'X', coefficients, context());
    const result = sampleFunctionCurve(evaluator, { lower: -2, upper: 2, minimum: [-2,0,-1], maximum: [2,1,1],
      tolerance: 0.001, maximumSamples: 20_000, maximumCells: 40_000, maximumDepth: 40 });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.status);
    expect(result.components).toHaveLength(1);
    const points = result.components[0];
    // Sampling retains crossing cells; functionCurveKernel.test checks the final
    // CAD edges after clipping, including the tensor expression at Y=1.
    expect(points[0].point[0]).toBeLessThanOrEqual(-1);
    expect(points.at(-1)?.point[0]).toBeGreaterThanOrEqual(1);
    expect(result.maximumChordErrorBound).toBeLessThanOrEqual(0.001);
    for (const { point } of points) {
      expect(point[0]).toBeGreaterThanOrEqual(-2); expect(point[0]).toBeLessThanOrEqual(2);
      expect(point[1]).toBeGreaterThanOrEqual(0);
      expect(point[2]).toBe(0); expect(point[1]).toBeCloseTo(point[0]**2, 12);
    }
  });
  it.each(['X+0*tensorelement([1,2],[3])', 'X+0*tensorelement([true],[1])',
    'X+0*kroneckerdelta(1.00000000000000001,1)'])('%sの誤りを簡約で隠さない', source => {
    expect(() => compileFunctionScalar(definition(source), ['X'], coefficients, context())).toThrow();
  });
});
