import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalCurvature } from './scalarCurveCurvature.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const scope = { axes: ['X', 'Y', 'Z'] as const, parameters: [], coefficients: [{ id: 'a', label: 'X', decimal: '3' }] };
const context = () => ({ backend, shouldStop: () => undefined });
function definition(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return createFunctionMathSource(source, 'text', angleUnit, scope, backend);
}
function tape(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return compileFunctionScalar(definition(source, angleUnit), scope.axes, scope.coefficients, context());
}

describe('明示した直交座標でベクトル解析の成分を作図に使う', () => {
  it.each([
    ['component(gradient(X^2+3*Y^2+Z^3,[X,Y,Z]),1)', 4],
    ['component(gradient(X^2+3*Y^2+Z^3,[X,Y,Z]),2)', 18],
    ['component(gradient(X^2+3*Y^2+Z^3,[X,Y,Z]),3)', 48],
    ['divergence([X^2,X*Y,Z^3],[X,Y,Z])', 54],
    ['component(curl([-Y,X,0],[X,Y,Z]),3)', 2],
    ['component(curl([0,0,X*Y],[X,Y,Z]),1)', 2],
    ['component(curl([0,0,X*Y],[X,Y,Z]),2)', -3],
    ['laplacian(X^2*Y+Z^3,[X,Y,Z])', 30],
    ['component(jacobian([X^2*Y,Y*Z],[X,Y,Z]),1,2)', 4],
    ['component(jacobian([X^2*Y,Y*Z],[X,Y,Z]),2,3)', 3],
    ['component(hessian(X^2*Y+Y*Z^3,[X,Y,Z]),2,3)', 48],
    ['component(hessian(X^2*Y+Y*Z^3,[X,Y,Z]),3,2)', 48],
    ['component(gradient(X^2+3*Y^2,[Y,X]),1)', 18],
    ['divergence(gradient(X^2+3*Y^2+Z^3,[X,Y,Z]),[X,Y,Z])', 32],
    ['component(curl(gradient(X*Y*Z,[X,Y,Z]),[X,Y,Z]),2)', 0],
    ['diff(component(gradient(X^3,[X]),1),X)', 12],
    ['component(gradient(5,[X,Y]),1)', 0],
    ['dot(gradient(X^2,[X,Y]),[2,3])', 8],
    ['component(grad(X^2+Y^2,[Y,X]),1)', 6],
    ['div([X^2,Y^2,Z^2],[X,Y,Z])', 18],
    ['gradient(X^2+Y^2,[X,Y]) · [2,3]', 26],
    ['component(hessian(X^2*Y,[X,Y]),1) · [2,3]', 24],
    ['component(hessian(X^2*Y,[X,Y]),1,2) × 3', 12],
  ])('%sを独立した解析値と照合する', (source, expected) => {
    expect(createScalarSampler(tape(source))([2, 3, 4])).toBeCloseTo(expected, 11);
  });
  it('角度の単位を微分ごとに適用する', () => {
    expect(createScalarSampler(tape('component(gradient(sin(X),[X]),1)', 'degree'))([30, 0, 0]))
      .toBeCloseTo(Math.PI / 180 * Math.cos(Math.PI / 6), 14);
    expect(createScalarSampler(tape('laplacian(sin(X),[X])', 'degree'))([30, 0, 0]))
      .toBeCloseTo(-0.5 * (Math.PI / 180) ** 2, 14);
  });
  it('成分選択後も他の成分の穴・尖点を消さず、区間をつながない', () => {
    for (const source of ['component(gradient(X^2+Y/Y,[X,Y]),1)',
      'component(gradient(X^2+abs(Y),[X,Y]),1)', '0*laplacian(abs(Y),[Y])',
      'component(jacobian([X^2,sqrt(Y)],[X,Y]),1,1)',
      'component(gradient(component([X^2,1/Y],1),[X]),1)']) {
      const compiled = tape(source);
      expect(Number.isNaN(createScalarSampler(compiled)([2, 0, 0]))).toBe(true);
      expect(createScalarIntervalSampler(compiled)([{ lower: 1, upper: 2 }, { lower: -1, upper: 1 }, { lower: 0, upper: 0 }]).continuous).toBe(false);
    }
  });
  it.each(['component(gradient(X^2,[X,X]),1)', 'component(gradient(X^2,[coef("X")]),1)',
    'divergence([X,Y],[X,Y,Z])', 'component(curl([X,Y],[X,Y]),1)', 'gradient([X,Y],[X,Y])',
    'laplacian([[X]],[X])', 'component(jacobian([],[X]),1,1)', 'component(gradient(X,[X]),2)',
    'component(gradient(X,[X,Y,Z,X]),1)', 'component(jacobian([X,1/0],[X]),1,1)'])(
    '%sで寸法・変数・不成立を黙って変更しない', source => { expect(() => tape(source)).toThrow(); });
  it('ベクトル・行列の行を一つの数として掛け算しない', () => {
    expect(() => tape('gradient(X^2+Y^2,[X,Y]) × 3')).toThrow();
    expect(() => tape('component(hessian(X^2*Y,[X,Y]),1) × 3')).toThrow();
  });
  it('保存・表示変換・係数編集で原式と変数の順序を保つ', () => {
    const source = 'component(hessian(coef("X")*X^2*Y,[Y,X]),1,2)';
    const original = definition(source), restored: unknown = JSON.parse(JSON.stringify(original));
    expect(createScalarSampler(compileFunctionScalar(restored, scope.axes, scope.coefficients, context()))([2, 3, 0])).toBe(12);
    expect(createScalarSampler(compileFunctionScalar(restored, scope.axes, [{ ...scope.coefficients[0], decimal: '5' }], context()))([2, 3, 0])).toBe(20);
    const request: MathWorkRequest = { identity: { documentId: 'part', documentVersion: 1, editorId: 'function', inputRevision: 1 },
      source, notation: 'text', angleUnit: 'radian', coefficients: scope.coefficients,
      functionScope: { axes: [...scope.axes], parameters: [] }, presentationNotation: 'latex' };
    const result = executeMathWorkRequest(createMathWorkEnvelope(1, request), backend);
    expect(result.evaluation.status).toBe('value');
    if (!result.presentation) throw new Error(JSON.stringify(result));
    expect(createScalarSampler(compileFunctionScalar(result.presentation, scope.axes, scope.coefficients, context()))([2, 3, 0])).toBe(12);
    expect(original.source).toBe(source);
  });
  it('全6演算の原式を構造入力へ変えても作図できる', () => {
    for (const source of ['component(gradient(X^2,[X]),1)', 'divergence([X^2],[X])',
      'component(curl([0,0,X*Y],[X,Y,Z]),1)', 'laplacian(X^3,[X])',
      'component(jacobian([X^2],[X]),1,1)', 'component(hessian(X^3,[X]),1,1)']) {
      const result = executeMathWorkRequest(createMathWorkEnvelope(1, {
        identity: { documentId: 'part', documentVersion: 1, editorId: 'function', inputRevision: 1 },
        source, notation: 'text', angleUnit: 'radian', coefficients: [],
        functionScope: { axes: [...scope.axes], parameters: [] }, presentationNotation: 'latex',
      }), backend);
      expect(result.evaluation.status, source).toBe('value');
      if (!result.presentation) throw new Error(JSON.stringify(result));
      const actual = createScalarSampler(compileFunctionScalar(result.presentation, scope.axes, [], context()))([2, 3, 4]);
      expect(actual, source).toBe(createScalarSampler(tape(source))([2, 3, 4]));
    }
  });
  it('曲率の上限を勾配成分の二階微分と照合する', () => {
    const curvature = createScalarDirectionalCurvature(tape('component(gradient(X^4,[X]),1)'), [1, 0, 0])(
      [{ lower: 1, upper: 2 }, { lower: 0, upper: 0 }, { lower: 0, upper: 0 }]);
    expect(curvature).not.toBeNull(); expect(curvature).toBeGreaterThanOrEqual(48); expect(curvature).toBeLessThan(48.000001);
  });
});
