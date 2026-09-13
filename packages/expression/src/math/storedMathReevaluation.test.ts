import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, decodeMathWorkRequest, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import type { StoredMathExpression } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const request: MathWorkRequest = {
  identity: { documentId: 'part', documentVersion: 1, editorId: 'point-X', inputRevision: 1 },
  source: 'coef("log") + sin(30)', notation: 'text', angleUnit: 'degree',
  coefficients: [{ id: 'thickness', label: 'log', decimal: '3' }],
};
function evaluate(input: MathWorkRequest) {
  return decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(1, input), backend), input, {
    operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['thickness']), declaredIds: new Set(),
  }).result;
}
function stored(): StoredMathExpression {
  const result = evaluate(request);
  if (result.definition === null) throw new Error('Expected a parsed definition');
  return result.definition;
}

describe('保存した数式は原式と一致を確認してから現在の係数で再計算する', () => {
  it('JSON往復後もID・度指定・元の式を保ち、係数変更で結果だけが追従する', () => {
    const original = stored();
    const decoded: unknown = JSON.parse(JSON.stringify({ ...request, definition: original }));
    const snapshot = decodeMathWorkRequest(decoded);
    const next = { ...snapshot, coefficients: [{ id: 'thickness', label: 'log', decimal: '10' }] };
    const result = evaluate(next);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 10.5 });
    expect(result.definition).toEqual(original);
    expect(snapshot.coefficients[0].decimal).toBe('3');
  });
  it('原式は同じでも保存ASTを別の値へ差し替えたファイルを評価しない', () => {
    const definition: StoredMathExpression = { ...stored(), expression: { kind: 'number', decimal: '999' } };
    expect(evaluate({ ...request, definition }).evaluation).toMatchObject({ status: 'invalid', reason: 'syntax' });
  });
  it.each(['source', 'inputNotation', 'angleUnit'] as const)('保存定義の%sと依頼が食い違えば送信前に断る', field => {
    const definition = stored();
    const values = { source: '999', inputNotation: 'latex', angleUnit: 'radian' };
    expect(() => decodeMathWorkRequest({ ...request, definition: { ...definition, [field]: values[field] } })).toThrow();
  });
  it('保存された未知の係数IDは同じ表示名があっても解決しない', () => {
    const definition = { ...stored(), expression: { kind: 'symbol', reference: { role: 'coefficient', id: 'removed', label: 'log' } } };
    expect(() => decodeMathWorkRequest({ ...request, definition })).toThrow();
  });
  it('保存されたASTを複製し、待機後の呼出元変更が式へ入り込まない', () => {
    const original = stored();
    const input = { ...request, definition: original };
    const snapshot = decodeMathWorkRequest(input);
    expect(snapshot.definition).not.toBe(original);
    expect(Object.isFrozen(original)).toBe(false);
    expect(Object.isFrozen(snapshot.definition)).toBe(true);
    expect(Object.isFrozen(snapshot.definition?.expression)).toBe(true);
    const expression = snapshot.definition?.expression;
    if (expression?.kind !== 'operation') throw new Error('Expected addition');
    expect(Object.isFrozen(expression.operands)).toBe(true);
    expect(Reflect.set(original, 'source', '999')).toBe(true);
    expect(snapshot.definition?.source).toBe(request.source);
    expect(evaluate(snapshot).evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3.5 });
  });
  it('オプションの定義にundefinedを明示した破損入力も無視しない', () => {
    expect(() => decodeMathWorkRequest({ ...request, definition: undefined })).toThrow();
  });
});
