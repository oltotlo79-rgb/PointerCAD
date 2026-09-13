import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, decodeMathWorkRequest, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { mathScalarExpression } from './mathScalarExpression.js';
import { createFunctionMathSource } from './functionMathSource.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const coefficients = [{ id: 'coefficient-X', label: 'X', decimal: '3' }];
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['coefficient-X']), declaredIds: new Set<string>() };
function request(source: string): MathWorkRequest {
  return { identity: { documentId: 'part', documentVersion: 1, editorId: 'function-Y', inputRevision: 1 }, source,
    notation: 'text', angleUnit: 'radian', coefficients, functionScope: { axes: ['X'], parameters: [] } };
}
function execute(input: MathWorkRequest) {
  return decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, input), backend), input, context).result;
}

describe('関数の原式を通常の数学パレットと同じ編集経路で確認する', () => {
  it.each(['sin(X)+coef("X")', '1/X', 'sqrt(X)', 'sum(X^2,X,1,3)+X', '3'])('%sを範囲未指定の数値へ変えず、関数の原式として保持する', source => {
    const result = execute(request(source));
    expect(result.definition?.source).toBe(source); expect(result.evaluation).toMatchObject({ status: 'value', kind: 'function' });
    expect(mathScalarExpression(result).ok).toBe(false);
  });

  it('媒介変数U/Vと出力軸XYZを区別し、指定していない軸を受け付けない', () => {
    const good = execute({ ...request('cos(U)*sin(V)'), functionScope: { axes: [], parameters: ['U','V'] } });
    expect(good.evaluation).toMatchObject({ status: 'value', kind: 'function' });
    expect(execute(request('Y+1')).evaluation.status).toBe('invalid');
    expect(execute({ ...request('X+U'), functionScope: { axes: [], parameters: ['U','V'] } }).evaluation.status).toBe('invalid');
  });

  it('省略されたスコープでは通常の座標編集として評価し、自由なXを自動で許可しない', () => {
    const base = request('2+3');
    const scalar: MathWorkRequest = { identity: base.identity, source: base.source, notation: base.notation, angleUnit: base.angleUnit, coefficients: [] };
    expect(mathScalarExpression(execute(scalar))).toMatchObject({ ok: true, value: { value: 5 } });
    expect(execute({ ...scalar, source: 'X+1' }).evaluation.status).toBe('invalid');
  });

  it('構造入力へ変換しても軸・係数・原式の意味を保ち、再編集できる', () => {
    const input = { ...request('sin(X)+coef("X")'), presentationNotation: 'latex' as const };
    const first = execute(input);
    expect(first.presentation?.inputNotation).toBe('latex');
    const definition = first.presentation;
    if (definition === null || definition === undefined) throw new Error('Expected LaTeX presentation');
    const reentered = execute({ ...request(definition.source), notation: 'latex', definition });
    expect(reentered.evaluation).toMatchObject({ status: 'value', kind: 'function' });
    expect(reentered.definition?.expression).toEqual(definition.expression);
  });

  it('原式の0除算を関数の定義確認で隠さず、変数一覧を不変の写しにする', () => {
    expect(execute(request('X+0*(1/0)')).evaluation.status).toBe('invalid');
    const axes: 'X'[] = ['X'];
    const copied = decodeMathWorkRequest({ ...request('X'), functionScope: { axes, parameters: [] } });
    axes.splice(0); expect(copied.functionScope?.axes).toEqual(['X']); expect(Object.isFrozen(copied.functionScope?.axes)).toBe(true);
    for (const scope of [{ axes: ['X','X'], parameters: [] }, { axes: ['pi'], parameters: [] }, { axes: [], parameters: ['W'] }]) {
      expect(() => decodeMathWorkRequest({ ...request('X'), functionScope: scope })).toThrow();
    }
  });

  it('返信の軸差替えや、関数の確認を実数の成功へ差し替える返信を拒否する', () => {
    const input = request('X'), reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    const y = createFunctionMathSource('Y', 'text', 'radian', { axes: ['Y'], parameters: [], coefficients }, backend).expression;
    expect(() => decodeMathWorkReply({ ...reply, expression: y, evaluation: { status: 'value', kind: 'function', expression: y } }, input, context)).toThrow();
    expect(() => decodeMathWorkReply({ ...reply, evaluation: { status: 'value', kind: 'real', exact: null, decimal: '3', coordinate: 3, approximation: null } }, input, context)).toThrow();
    expect(() => decodeMathWorkReply({ ...reply, evaluation: { status: 'value', kind: 'function', expression: { kind: 'number', decimal: '3' } } }, input, context)).toThrow();
  });
});
