import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkRequest, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { mathScalarExpression } from './mathScalarExpression.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['coefficient:1']), declaredIds: new Set<string>() };
function request(): MathWorkRequest {
  const original: MathWorkRequest = { identity: { documentId: 'doc', documentVersion: 1, editorId: 'rename-test', inputRevision: 1 },
    source: 'coef("i") + 2', notation: 'text', angleUnit: 'degree', coefficients: [{ id: 'coefficient:1', label: 'i', decimal: '3' }] };
  const value = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: original }, backend);
  const definition = decodeMathWorkReply(value, original, context).result.definition;
  if (definition === null) throw new Error('Expected definition');
  return { ...original, definition, renameCoefficient: { id: 'coefficient:1', label: '幅' } };
}
describe('係数改名のWorker境界', () => {
  it('改名結果は数式として保存できても座標として直接採用できない', () => {
    const input = request();
    const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 2, request: input }, backend);
    const result = decodeMathWorkReply(raw, input, context).result;
    expect(result.renamedDefinition?.source).toContain('幅');
    expect(result.definition?.source).toBe(input.source);
    expect(mathScalarExpression(result).ok).toBe(false);
  });
  it.each(['label', 'value', 'notation', 'coordinate'] as const)('返信の%s改ざんを拒否する', mode => {
    const input = request(), raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 2, request: input }, backend);
    if (raw.renamedDefinition == null || input.definition === undefined) throw new Error('Expected renamed definition');
    const changed = mode === 'label' ? { ...raw, renamedDefinition: input.definition }
      : mode === 'value' ? { ...raw, renamedDefinition: { ...raw.renamedDefinition, expression: { kind: 'number', decimal: '999' } } }
      : mode === 'notation' ? { ...raw, renamedDefinition: { ...raw.renamedDefinition, inputNotation: 'latex' } }
      : { ...raw, evaluation: { status: 'value', kind: 'real', exact: { kind: 'number', decimal: '5' }, decimal: '5', coordinate: 5, approximation: null } };
    expect(() => decodeMathWorkReply(changed, input, context)).toThrow();
  });
  it('依頼の改名情報を複製し、呼出元の後書換から切り離す', () => {
    const input = request(), rename = { id: 'coefficient:1', label: '幅' };
    const copied = decodeMathWorkRequest({ ...input, renameCoefficient: rename });
    rename.label = '後書換';
    expect(copied.renameCoefficient?.label).toBe('幅');
    expect(Object.isFrozen(copied.renameCoefficient)).toBe(true);
  });
  it.each(['unknown', 'duplicate', 'without-definition', 'combined'] as const)('%sの改名依頼を受け入れない', mode => {
    const input = request();
    const invalid = mode === 'unknown' ? { ...input, renameCoefficient: { id: 'missing', label: '幅' } }
      : mode === 'duplicate' ? { ...input, coefficients: [...input.coefficients, { id: 'other', label: '幅', decimal: '4' }] }
      : mode === 'combined' ? { ...input, presentationNotation: 'latex' }
      : { ...input, definition: undefined };
    expect(() => decodeMathWorkRequest(invalid)).toThrow();
  });
});
