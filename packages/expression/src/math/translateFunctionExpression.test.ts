import { beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber as number } from '../evaluateExpression.js';
import { bindMathCompositionNames } from './mathComposition.js';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionMathSource, readFunctionMathSource } from './functionMathSource.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { collectMathCoefficients } from './mathExpressionReferences.js';
import { translateFunctionExpression } from './translateFunctionExpression.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import type { MathNode } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const scope = { axes: ['X'] as const, parameters: [], coefficients: [{ id: 'coefficient:1', label: 'X' }] };
const math = (source: string, angleUnit: 'degree' | 'radian' = 'radian') => createFunctionMathSource(source, 'text', angleUnit, scope, backend);
const keep = { kind: 'keep' } as const;

describe('原点変更の関数式を構造で変換する', () => {
  it('度のsinを平行移動しても、30度の意味を保持する', () => {
    const moved = translateFunctionExpression(math('sin(X)', 'degree'),
      { X: { kind: 'subtract', amount: number(30) }, Y: { kind: 'subtract', amount: number(2) }, Z: keep }, 'Y');
    const evaluate = createFunctionCurveEvaluator([math('X'), moved, math('0')], 'X', [], { backend, shouldStop: () => undefined });
    expect(evaluate.point(0)?.[1]).toBeCloseTo(-1.5, 12);
    expect(evaluate.point(60)?.[1]).toBeCloseTo(-1, 12);
  });
  it('軸Xと同名の係数Xを区別し、inch指定の移動量をmmで解釈する', () => {
    const amount = { source: '(X+1)in', value: 999, display: '999' };
    bindMathCompositionNames(amount, [{ id: 'coefficient:1', label: 'X', kind: 'length' }]);
    const moved = translateFunctionExpression(math('X + coef("X")'), { X: { kind: 'subtract', amount }, Y: keep, Z: keep }, 'Y');
    const evaluate = createFunctionCurveEvaluator([math('X'), moved, math('0')], 'X',
      [{ id: 'coefficient:1', label: 'X', decimal: '10' }], { backend, shouldStop: () => undefined });
    expect(evaluate.point(0)?.[1]).toBeCloseTo(45.4, 12);
    expect(collectMathCoefficients(moved.expression)).toEqual([{ role: 'coefficient', id: 'coefficient:1', label: 'X' }]);
  });
  it('総和の束縛変数Xを座標軸として移動せず、自由なXだけを置換する', () => {
    const moved = translateFunctionExpression(math('sum(X,X,1,3) + X'), { X: { kind: 'subtract', amount: number(2) }, Y: keep, Z: keep });
    const decoded = readFunctionMathSource(moved, scope, backend), bindings: MathNode[] = [];
    const visit = (node: MathNode) => {
      if (node.kind === 'binder') { bindings.push(node.body); visit(node.body); }
      else if (node.kind === 'operation') node.operands.forEach(visit);
    };
    visit(decoded.expression);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ kind: 'symbol', reference: { role: 'bound' } });
    expect(moved.source).toContain('2');
  });
  it('移動しない場合は同一の原式を返し、旧式の係数の単位が未準備なら推測しない', () => {
    const original = math('X^2');
    expect(translateFunctionExpression(original, { X: keep, Y: keep, Z: keep })).toBe(original);
    expect(() => translateFunctionExpression(original, { X: { kind: 'subtract', amount: { source: '幅', value: 7, display: '7' } }, Y: keep, Z: keep })).toThrow('係数');
  });
});
