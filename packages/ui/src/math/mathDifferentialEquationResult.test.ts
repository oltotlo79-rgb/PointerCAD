import { describe, expect, it } from 'vitest';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import type { MathEvaluation, MathNode } from '@pointercad/expression/math/contracts';
import { mathDifferentialEquationResult } from './mathDifferentialEquationResult.js';

const number = (decimal: string): MathNode => ({ kind: 'number', decimal });
function result(freeConstant: boolean): Extract<MathEvaluation, { kind: 'ode-solutions' }> {
  const request = { identity: { documentId: 'ode-view', documentVersion: 1, editorId: 'X', inputRevision: 1 },
    source: 'odesolve([diff(y,x)=z,diff(z,x)=0],x,[y,z],[])', notation: 'text' as const,
    angleUnit: 'degree' as const, coefficients: [] };
  const parsed = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, createMathBackend());
  const expression = parsed.expression;
  if (expression?.kind !== 'operation' || expression.operands[0].kind !== 'binder') throw new Error('元の式がありません');
  const independent = expression.operands[0].bindings[0];
  const bindings = freeConstant ? [independent, { variable: { role: 'bound' as const,
    id: independent.variable.id + '/ode-constant/1', label: 'C1' }, domain: { kind: 'unrestricted' as const } }] : [independent];
  const constant: MathNode = freeConstant ? { kind: 'symbol', reference: bindings[1].variable } : number('3');
  const body: MathNode = { kind: 'operation', operation: 'list', operands: [constant, number('0')] };
  const condition: MathNode = freeConstant ? { kind: 'operation', operation: 'not-equal',
    operands: [{ kind: 'symbol', reference: independent.variable }, number('0')] } : { kind: 'constant', name: 'true' };
  return { status: 'value', kind: 'ode-solutions', expression, solutions: { coverage: 'verified-branches', branches: [
    { formula: { kind: 'binder', operation: 'lambda', bindings, body },
      originals: { kind: 'binder', operation: 'lambda', bindings, body: { kind: 'operation', operation: 'list', operands: [] } },
      condition: { kind: 'binder', operation: 'lambda', bindings, body: condition } },
  ] } };
}

describe('微分方程式の候補・条件・関数の順番を表示する', () => {
  it('確認した候補を全解と呼ばず、初期値で決まった定数を追加指定させない', () => {
    const input = result(false), before = JSON.stringify(input), view = mathDifferentialEquationResult(input);
    expect(view.message).toBe('微分方程式の確認できた解候補（全ての解とは限りません）');
    expect(view.detail).toContain('y(x) = 3, z(x) = 0');
    expect(view.detail).toContain('指定が必要な積分定数: なし');
    expect(view.detail).toContain('使う位置でも元の式を確認します');
    expect(view.detail).toContain('component');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('自由な定数と成立条件を消さず、候補番号を値の選択につなげる', () => {
    const view = mathDifferentialEquationResult(result(true));
    expect(view.detail).toContain('候補 1:');
    expect(view.detail).toContain('y(x) = C1, z(x) = 0');
    expect(view.detail).toContain('指定が必要な積分定数: C1');
    expect(view.detail).toContain('x ≠ 0');
    expect(view.detail).not.toContain('表示する追加条件はありません');
    expect(view.detail).toContain('odeat');
  });
});
