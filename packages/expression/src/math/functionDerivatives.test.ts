import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalCurvature } from './scalarCurveCurvature.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { sampleFunctionCurve } from './adaptiveFunctionCurve.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'scale', label: 'X', decimal: '3' }];
const context = () => ({ backend, shouldStop: () => undefined });
function definition(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return createFunctionMathSource(source, 'text', angleUnit, { axes: ['X', 'Y'], parameters: [], coefficients }, backend);
}
function tape(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return compileFunctionScalar(definition(source, angleUnit), ['X', 'Y'], coefficients, context());
}

describe('導関数を一度だけ準備し、元の定義域と共に曲線・曲面へ渡す', () => {
  it.each([
    ['diff(X^3,X)', 2, 12], ['diff(X^3,X,X)', 2, 12], ['diff(X^3,X,X,X)', 2, 6],
    ['diff(X^3,X,X,X,X)', 2, 0], ['diff(X,X)', 0, 1], ['diff(X^2,X)', 0, 0],
    ['diff(X^2*Y+3*Y^2,X,Y)', 2, 4], ['diff(diff(X^2*Y,X),Y)', 2, 4],
    ['diff(X/Y,X)', 2, 0.2], ['diff(X/Y,Y)', 2, -0.08],
    ['diff(sqrt(X),X)', 4, 0.25], ['diff(root(X,3),X)', -8, 1/12],
    ['diff(X^(5/3),X)', -8, 20/3], ['diff(ln(X),X)', 2, 0.5],
    ['diff(abs(X),X)', -2, -1], ['diff(abs(X),X,X)', -2, 0],
    ['diff(sin(X^2),X)', 2, 4*Math.cos(4)], ['diff(exp(X),X,X)', 2, Math.exp(2)],
    ['diff(atan(X),X)', 2, 0.2], ['diff(sinh(X),X)', 2, Math.cosh(2)],
    ['diff(log2(X),X)', 2, 1/(2*Math.LN2)], ['diff(log10(X),X)', 2, 1/(2*Math.LN10)],
    ['diff(log(X,3),X)', 2, 1/(2*Math.log(3))], ['diff(X^X,X)', 2, 4*(1+Math.LN2)],
    ['diff(tan(X),X)', 0.5, 1/Math.cos(0.5)**2], ['diff(cot(X),X)', 0.5, -1/Math.sin(0.5)**2],
    ['diff(sec(X),X)', 0.5, Math.tan(0.5)/Math.cos(0.5)], ['diff(csc(X),X)', 0.5, -1/Math.sin(0.5)/Math.tan(0.5)],
    ['diff(acos(X),X)', 0.5, -1/Math.sqrt(0.75)], ['diff(cosh(X),X)', 2, Math.sinh(2)],
    ['diff(tanh(X),X)', 2, 1/Math.cosh(2)**2], ['diff(asinh(X),X)', 2, 1/Math.sqrt(5)],
    ['diff(acosh(X),X)', 2, 1/Math.sqrt(3)], ['diff(atanh(X),X)', 0.5, 4/3],
  ])('%sは独立した解析値を返す', (source, x, expected) => {
    expect(createScalarSampler(tape(source))([x, 5])).toBeCloseTo(expected, 11);
  });
  it('度の微分係数を一回ごとに含め、逆三角関数では逆数にする', () => {
    expect(createScalarSampler(tape('diff(sin(X),X)', 'degree'))([30, 0])).toBeCloseTo(Math.PI/180*Math.cos(Math.PI/6), 14);
    expect(createScalarSampler(tape('diff(sin(X),X,X)', 'degree'))([30, 0])).toBeCloseTo(-0.5*(Math.PI/180)**2, 14);
    expect(createScalarSampler(tape('diff(asin(X),X)', 'degree'))([0.5, 0])).toBeCloseTo(180/Math.PI/Math.sqrt(0.75), 12);
  });
  it('高階と偏微分の構造表示でも変数の順序と作図結果を保つ', () => {
    for (const source of ['diff(X^3,X,X)', 'diff(X^2*Y,X,Y)']) {
      const request: MathWorkRequest = { identity: { documentId: 'part', documentVersion: 1, editorId: 'function', inputRevision: 1 },
        source, notation: 'text', angleUnit: 'radian', coefficients: [], functionScope: { axes: ['X', 'Y'], parameters: [] },
        presentationNotation: 'latex' };
      const result = executeMathWorkRequest(createMathWorkEnvelope(1, request), backend);
      expect(result.presentation?.inputNotation).toBe('latex');
      if (!result.presentation) throw new Error(JSON.stringify(result));
      const evaluate = createScalarSampler(compileFunctionScalar(result.presentation, ['X', 'Y'], [], context()));
      expect(evaluate([2, 5])).toBe(source.includes('Y') ? 4 : 12);
    }
  });
  it.each(['diff(X/X,X)', 'diff(0*sqrt(X),X)', 'diff(abs(X),X)', 'diff(abs(X),X,X)',
    'diff(X^(3/2),X)', 'diff(X^0,X)', 'diff(diff(X/X,X),Y)'])(
    '%sで元の穴・尖点・片側だけの領域を有効な0で埋めない', source => {
      const compiled = tape(source);
      expect(Number.isNaN(createScalarSampler(compiled)([0, 0]))).toBe(true);
      expect(createScalarIntervalSampler(compiled)([{ lower: -1, upper: 1 }, { lower: 0, upper: 0 }]).continuous).toBe(false);
    });
  it('微分しない軸を固定し、その軸の尖点を別の軸の不成立と混同しない', () => {
    expect(createScalarSampler(tape('diff(abs(Y),X)'))([0, 0])).toBe(0);
  });
  it('係数のIDと原式を保存し、同名の軸・係数と再編集を区別する', () => {
    const original = definition('diff(coef("X")*X^2,X)'), before = JSON.stringify(original);
    const restored: unknown = JSON.parse(before);
    const initial = createScalarSampler(compileFunctionScalar(restored, ['X', 'Y'], coefficients, context()));
    const changed = createScalarSampler(compileFunctionScalar(restored, ['X', 'Y'], [{ ...coefficients[0], decimal: '5' }], context()));
    expect(initial([2, 0])).toBe(12); expect(changed([2, 0])).toBe(20);
    expect(JSON.stringify(original)).toBe(before);
    expect(() => tape('diff(X,coef("X"))')).toThrow();
  });
  it('微分後の曲率の上限を解析的な三階微分と照合する', () => {
    const bound = createScalarDirectionalCurvature(tape('diff(X^4+X*Y,X)'), [1, 0])(
      [{ lower: 1, upper: 2 }, { lower: -3, upper: 3 }]);
    expect(bound).not.toBeNull();
    expect(bound).toBeGreaterThanOrEqual(48); expect(bound).toBeLessThan(48.000001);
  });
  it('微分した直線を共有端点で作図し、元の式を保存に残す', () => {
    const inputs = ['X', 'diff(X^2,X)', '0'].map(source => createFunctionMathSource(source, 'text', 'radian',
      { axes: ['X'], parameters: [], coefficients: [] }, backend));
    const evaluator = createFunctionCurveEvaluator([inputs[0], inputs[1], inputs[2]], 'X', [], context());
    const result = sampleFunctionCurve(evaluator, { lower: -2, upper: 2, minimum: [-2, -4, -1], maximum: [2, 4, 1],
      tolerance: 0.001, maximumSamples: 2000, maximumCells: 4000, maximumDepth: 30 });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.components[0][0].point).toEqual([-2, -4, 0]);
    expect(result.components[0].at(-1)?.point).toEqual([2, 4, 0]);
    expect(inputs[1].source).toBe('diff(X^2,X)');
  });
  it('未対応の微分と複雑すぎる展開を有限に断る', () => {
    expect(() => tape('diff(min(X,Y),X)')).toThrow();
    expect(() => tape('diff(sin(sin(sin(sin(X)))),X,X,X,X,X,X,X,X,X,X,X,X,X,X,X)')).toThrow();
  });
});
