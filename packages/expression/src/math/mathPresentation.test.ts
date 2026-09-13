import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['thickness']), declaredIds: new Set<string>() };
function request(source: string): MathWorkRequest {
  return { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 1 },
    source, notation: 'text', angleUnit: 'degree', presentationNotation: 'latex',
    coefficients: [{ id: 'thickness', label: 'log', decimal: '3' }] };
}
describe('Workerで意味を照合してから数式入力方式を切り替える', () => {
  it.each(['coef("log")*sin(30)', 'sum(i^2,i,1,10)', '1/3', 'log(100,10)', 'log(8,2)', 'log10(100)', 'log2(8)'])('%sを構造入力へ変えて再評価し、テキストにも戻せる', source => {
    const original = request(source);
    const output = executeMathWorkRequest(createMathWorkEnvelope(1, original), backend);
    const first = decodeMathWorkReply(output, original, context).result;
    if (first.presentation === undefined || first.presentation === null) throw new Error('Expected converted notation');
    const next: MathWorkRequest = { ...original, source: first.presentation.source, notation: 'latex',
      definition: first.presentation, presentationNotation: 'text' };
    const second = decodeMathWorkReply(executeMathWorkRequest(createMathWorkEnvelope(2, next), backend), next, context).result;
    expect(first.evaluation).toMatchObject({ status: 'value', kind: 'real' });
    expect(second.evaluation).toEqual(first.evaluation);
    expect(first.definition?.source).toBe(source);
    expect(second.presentation?.inputNotation).toBe('text');
  });
  it('変換後のASTが別の値になったWorker返信を採用しない', () => {
    const input = request('1/3'), reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    expect(() => decodeMathWorkReply({ ...reply, presentation: { ...reply.presentation, expression: { kind: 'number', decimal: '999' } } }, input, context)).toThrow();
  });
});
