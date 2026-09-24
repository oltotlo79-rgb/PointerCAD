import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import type { MathNode } from './mathInputContract.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

let backend: MathExecutionBackend;
const script = fileURLToPath(new URL('./exactRuntime/cas_taylor_test.py', import.meta.url));
const engine = { evaluate(expression: MathNode, angleUnit: 'degree' | 'radian'): Promise<unknown> {
  const execution = spawnExactRuntime(['-B', '-X', 'utf8', script, '--batch'], {
    input: JSON.stringify([{ expression, angleUnit }]), encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (execution.status !== 0 || execution.error !== undefined) throw new Error(`${execution.error?.message ?? ''}\n${execution.stderr}`);
  const values: unknown = JSON.parse(execution.stdout);
  if (!Array.isArray(values) || values.length !== 1) throw new Error('係数の計算結果が不正です。');
  return Promise.resolve(values[0]);
} };
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'coefficient', documentVersion: 1, editorId: 'X', inputRevision: 1 } };
}
beforeAll(() => { backend = createMathBackend(); });

describe('展開した係数を次数で選び、元の展開式を数値欄へ保存する', () => {
  it.each([
    ['seriescoefficient(taylor(x^3,x,2,4),1)', 12],
    ['2*seriescoefficient(taylor(x^3,x,2,4),1)+1', 25],
    ['seriescoefficient(maclaurin(exp(x),x,4),3)', 1 / 6],
    ['seriescoefficient(maclaurin(1/(1-x),x,4),4)', 1],
    ['seriescoefficient(taylor((x-1)/(x-1),x,2,3),0)', 1],
    ['sequencevalue(seriescoefficient(taylor(x^2,x,n,2),1),n,3)', 6],
    ['re(seriescoefficient(maclaurin(i*x,x,2),1))', 0],
  ] as const)('%sの値・原式・表示往復を保持する', async (source, coordinate) => {
    const input = { ...request(source), presentationNotation: 'latex' as const };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(1, input), { backend, engine, shouldStop: () => undefined });
    const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
      coefficientIds: new Set<string>(), declaredIds: new Set<string>() }).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate });
    expect(result.definition?.source).toBe(source);
    if (result.definition === null || raw.expression === null || raw.presentation === undefined || raw.presentation === null) throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    const back = executeMathWorkRequest(createMathWorkEnvelope(2, { ...input, source: raw.presentation.source,
      notation: 'latex', definition: raw.presentation, presentationNotation: 'text' }), backend);
    if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(raw.expression, back.presentation.expression)).toBe(true);
    const stored: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
    const reopened = await executeExactMathWorkRequest(stored, { backend, engine, shouldStop: () => undefined });
    expect(reopened.evaluation).toEqual(result.evaluation);
  }, 30_000);
  it.each([
    'seriescoefficient(taylor(abs(x),x,0,3),0)',
    '0*seriescoefficient(taylor(abs(x),x,0,3),0)',
    'component([7,seriescoefficient(taylor(abs(x),x,0,3),0)],1)',
    'seriescoefficient(taylor(1/x,x,0,3),0)',
    'seriescoefficient(taylor(x,x,0,3),-1)',
    'seriescoefficient(taylor(x,x,0,3),1/2)',
    'seriescoefficient(taylor(x,x,0,3),4)',
    'seriescoefficient(7,0)',
    '1/0+seriescoefficient(taylor(x,x,0,3),1)',
  ])('%sを数値として採用しない', async source => {
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(4, request(source)), { backend, engine, shouldStop: () => undefined });
    expect(raw.evaluation.status).not.toBe('value');
    expect(raw.evaluation).not.toHaveProperty('coordinate');
  });
  it('保存した係数の参照と局所変数を区別し、値の変更を再計算する', async () => {
    const source = 'seriescoefficient(taylor(coef("x")*x^3,x,coef("中心"),4),1)';
    for (const decimal of ['2', '3']) {
      const input: MathWorkRequest = { ...request(source), coefficients: [
        { id: 'a', label: 'x', decimal }, { id: 'center', label: '中心', decimal: '2' }] };
      const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(5, input), { backend, engine, shouldStop: () => undefined });
      const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
        coefficientIds: new Set(['a', 'center']), declaredIds: new Set<string>() }).result;
      expect(result.definition?.source).toBe(source);
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: Number(decimal) * 12 });
    }
  });
});
