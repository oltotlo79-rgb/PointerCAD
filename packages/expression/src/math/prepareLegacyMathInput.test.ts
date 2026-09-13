import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateExpression } from '../evaluateExpression.js';
import { prepareLegacyMathInput } from './prepareLegacyMathInput.js';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
describe('旧短式を数式入力で開いても識別子と単位の意味を保つ', () => {
  it.each(['i+sin+log', '(幅+1)in', 'rad(1)', 'root(-8,3)', 'abs(-3)+sqrt(9)', '-2^2'])('%sを変換しても同じ値になる', source => {
    const coefficients = [{ id: 'one', label: 'i', decimal: '2' }, { id: 'two', label: 'sin', decimal: '3' },
      { id: 'three', label: 'log', decimal: '4' }, { id: 'four', label: '幅', decimal: '25.4' }];
    const text = prepareLegacyMathInput(source, { resolveVariable: name => {
      const coefficient = coefficients.find(coefficient => coefficient.label === name);
      return coefficient === undefined ? null : { reference: { role: 'coefficient', id: coefficient.id, label: name },
        kind: name === '幅' ? 'length' : 'scalar' };
    } });
    const request = { identity: { documentId: 'legacy', documentVersion: 1, editorId: 'convert', inputRevision: 1 },
      source: text, notation: 'text' as const, angleUnit: 'degree' as const, coefficients };
    const result = decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
      { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result;
    const previous = evaluateExpression(source, { variables: new Map(coefficients.map(coefficient => [coefficient.label, Number(coefficient.decimal)])),
      nonLengthVariables: new Set(['i', 'sin', 'log']) });
    expect(previous.ok).toBe(true);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
    if (previous.ok && result.evaluation.status === 'value' && result.evaluation.kind === 'real') {
      expect(result.evaluation.coordinate).toBeCloseTo(previous.value.value, 11);
    }
  });
});
