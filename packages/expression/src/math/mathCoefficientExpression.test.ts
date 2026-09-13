import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateExpression } from '../evaluateExpression.js';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarSampler } from './scalarMathTape.js';
import { solveImplicitFunctionPoints } from './solveImplicitFunctionPoints.js';
import { exactCoordinatePolynomial } from './exactCoordinatePolynomial.js';
import { decodeMathCoefficientValues } from './mathWorkRequest.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { coefficientExpressionMap, decodeCoefficientExpression, exactCoefficientScalar,
  originalCoefficientExpression, substituteCoefficientExpressions, type MathCoefficientValue } from './mathCoefficientExpression.js';
import type { MathNode } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const noNames = { resolveVariable: () => null };
const number = (decimal: string): MathNode => ({ kind: 'number', decimal });
const scope = { axes: ['X'] as const, parameters: [], coefficients: [] };

function legacy(label: string, source: string): MathCoefficientValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(result.error.message);
  return { id: label, label, decimal: String(result.value.value), exactExpression: originalCoefficientExpression(result.value, noNames, []) };
}
function tape(source: string, coefficients: readonly MathCoefficientValue[], angleUnit: 'degree' | 'radian' = 'degree') {
  const definition = createFunctionMathSource(source, 'text', angleUnit, { ...scope, coefficients }, backend);
  return compileFunctionScalar(definition, ['X'], coefficients, { backend, shouldStop: () => undefined });
}

describe('係数の丸めを原式の精度証明と混同しない', () => {
  it('1/3を10の40乗で増幅しても元の有理数から0を求める', () => {
    const r = legacy('r', '1/3');
    const compiled = tape('X + (coef("r")*3-1)*10^40', [r]);
    expect(createScalarSampler(compiled)([0])).toBe(0);
    expect(createScalarIntervalSampler(compiled)([{ lower: 0, upper: 0 }])).toEqual({ continuous: true, ranges: [{ lower: 0, upper: 0 }] });
  });

  it('陰関数の多項式による交点判定も同じ分数を使用する', () => {
    const coefficients = [legacy('r', '1/3')];
    const expression = createFunctionMathSource('X + (coef("r")*3-1)*10^40', 'text', 'degree',
      { axes: ['X', 'Y', 'Z'], parameters: [], coefficients }, backend);
    expect(exactCoordinatePolynomial(expression.expression, coefficientExpressionMap(coefficients), () => false))
      .toEqual(new Map([['1,0,0', { numerator: 1n, denominator: 1n }]]));
    const result = solveImplicitFunctionPoints({ expression, coefficients, minimum: [-2, -2, -2], maximum: [2, 2, 2],
      known: [{ axis: 'Y', value: 0 }, { axis: 'Z', value: 0 }], tolerance: 1e-6 }, { backend, shouldStop: () => undefined });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.status);
    expect(result.exhaustive).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].point).toEqual([0, 0, 0]);
  });

  it('πの係数を表示用の小数で固定せず、元の値を挟む', () => {
    const compiled = tape('coef("p")', [legacy('p', 'pi')]);
    const result = createScalarIntervalSampler(compiled)([{ lower: 0, upper: 0 }]);
    expect(result.continuous).toBe(true);
    expect(result.ranges[0].lower).toBeLessThanOrEqual(Math.PI);
    expect(result.ranges[0].upper).toBeGreaterThan(Math.PI);
  });

  it.each(['degree', 'radian'] as const)('係数の度と関数側の%sを混ぜない', angleUnit => {
    const definition = createFunctionMathSource('sin(30)', 'text', 'degree', { axes: [], parameters: [], coefficients: [] }, backend);
    const source = { source: definition.source, value: 0.5, display: '0.5', mathDefinition: definition };
    const coefficient = { id: 'a', label: 'a', decimal: '0.5', exactExpression: originalCoefficientExpression(source, noNames, []) };
    const compiled = tape('X+coef("a")', [coefficient], angleUnit);
    expect(createScalarSampler(compiled)([0])).toBeCloseTo(0.5, 12);
    const range = createScalarIntervalSampler(compiled)([{ lower: 0, upper: 0 }]).ranges[0];
    expect(range.lower).toBeLessThanOrEqual(0.5);
    expect(range.upper).toBeGreaterThanOrEqual(0.5);
  });

  it('係数の依存を展開してから丸めるので、旧形式の式でも差を増幅しない', () => {
    const r = legacy('r', '1/3');
    const names = { resolveVariable: () => ({ reference: { role: 'coefficient' as const, id: 'r', label: 'r' }, kind: 'scalar' as const }) };
    const value = { source: '(r*3-1)*10^40', value: -1, display: '-1' };
    const original = originalCoefficientExpression(value, names, [r]);
    expect(exactCoefficientScalar(original)).toEqual({ value: 0, decimal: '0', display: '0' });
  });

  it('座標欄のWorkerも係数の原式を使う', () => {
    const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: {
      identity: { documentId: 'd', documentVersion: 1, editorId: 'e', inputRevision: 1 },
      source: '(coef("r")*3-1)*10^40', notation: 'text', angleUnit: 'degree', coefficients: [legacy('r', '1/3')],
    } }, backend);
    expect(reply.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 0, decimal: '0' });
  });

  it('送信時に原式を分離・凍結し、未確定の座標を拒否する', () => {
    const expression = { kind: 'operation' as const, operation: 'divide', operands: [number('1'), number('3')] };
    const values = decodeMathCoefficientValues([{ id: 'r', label: 'r', decimal: '0.333', exactExpression: expression }]);
    expression.operands[0] = number('7');
    expect(values[0].exactExpression).toEqual({ kind: 'operation', operation: 'divide', operands: [number('1'), number('3')] });
    expect(Object.isFrozen(values[0].exactExpression)).toBe(true);
    expect(() => decodeCoefficientExpression({ kind: 'symbol', reference: { role: 'axis', name: 'X' } })).toThrow('未確定');
  });

  it('同じ束縛付き係数を2回使っても局所変数が衝突しない', () => {
    const definition = createFunctionMathSource('sum(k, k, 1, 3)', 'text', 'degree', { axes: [], parameters: [], coefficients: [] }, backend);
    const coefficient = { id: 's', label: 's', decimal: '6', exactExpression: definition.expression };
    const reference: MathNode = { kind: 'symbol', reference: { role: 'coefficient', id: 's', label: 's' } };
    const result = substituteCoefficientExpressions({ kind: 'operation', operation: 'add', operands: [reference, reference] }, coefficientExpressionMap([coefficient]));
    expect(() => decodeCoefficientExpression(result)).not.toThrow();
  });

  it('係数ごとの上限だけでなく依頼全体の原式の量も制限する', () => {
    const expression: MathNode = { kind: 'operation', operation: 'add', operands: Array.from({ length: 256 }, () => number('1')) };
    const coefficients = Array.from({ length: 17 }, (_, index) => ({ id: `c${index}`, label: `c${index}`, decimal: '256', exactExpression: expression }));
    expect(() => decodeMathCoefficientValues(coefficients)).toThrow('合計');
  });

  it('定数のべき乗を扱っても、0の0乗や0で割る原式を消さない', () => {
    for (const source of ['X+0*(0^0)', 'X+0*(1/0)', 'X+(0^(-1))']) {
      const expression = createFunctionMathSource(source, 'text', 'degree', scope, backend);
      expect(exactCoordinatePolynomial(expression.expression, new Map(), () => false)).toBeNull();
    }
  });
});
