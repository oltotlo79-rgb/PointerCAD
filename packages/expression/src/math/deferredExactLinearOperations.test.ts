import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const a = '[[sqrt(2),1],[2,sqrt(2)]]';
const scalar = { status: 'value', kind: 'real', expression: { kind: 'number', decimal: '3' },
  domainConditions: [], coordinateAuthorized: false };
async function evaluate(source: string, raw: unknown = scalar) {
  const request: MathWorkRequest = { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'linear', documentVersion: 4, editorId: 'input', inputRevision: 7 } };
  const engine = vi.fn(() => Promise.resolve(raw));
  const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(17, request), {
    backend, engine: { evaluate: engine }, shouldStop: () => undefined,
  });
  const decoded = decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() });
  return { engine, reply, result: decoded.result };
}

describe('代数的な行列を全成分の検証後に渡し、実計算の形を受け取る', () => {
  it.each([
    `component(rowreduce(${a}),1,2)`, `component(nullspace(${a}),1,1)`,
    `component(columnspace(${a}),1,2)`, `component(rowspace(${a}),1,2)`,
    'component(linearsolve([[sqrt(2),1],[1,sqrt(2)]],[2*sqrt(2)+3,2+3*sqrt(2)]),1)',
    `component(linearsolutionspace(${a},[3*sqrt(2),6]),1,1)`,
    `component(component(rowreduce(${a}),1),2)`,
    `component(qrq(${a}),1,1)`, `component(qrr(${a}),1,2)`,
    `component(eigenvalues(${a}),1)`, `component(singularvalues(${a}),2)`,
    `component(svdu(${a}),1,1)`, `component(svds(${a}),1,2)`, `component(svdv(${a}),2,1)`,
    'component(singularvalues([[2,1,0],[1,2,1],[0,1,2]]),1)',
    `component(lup(${a}),1,1)`, `component(lul(${a}),2,1)`, `component(luu(${a}),1,2)`,
    `component(characteristiccoefficients(${a}),3)`,
    'component(eigenspace([[sqrt(2),0],[0,sqrt(3)]],sqrt(2)),1,1)',
    'component(eigenspace([[0,1],[2,0]],sqrt(2)+sqrt(3)),1,1)',
  ])('成分を先に数値へ置き換えず元の演算を送る: %s', async source => {
    // This tests dispatch and the envelope, not the engine's algebra.
    // Independent numerical/linear identities are exercised by the real runtime flow.
    const value = await evaluate(source);
    expect(value.engine).toHaveBeenCalledOnce();
    expect(value.engine).toHaveBeenCalledWith(expect.objectContaining({ operation: 'component' }), 'degree');
    expect(value.reply.source).toBe(source);
    expect(value.result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 3 });
  });
  it.each([
    'rowreduce([[sqrt(2),1],[2]])', 'nullspace([[sqrt(2),1],[2,true]])',
    'columnspace([[sqrt(2),1],[2,1/0]])', 'rowspace([[[sqrt(2),1]],[[2,3]]])',
    `linearsolve(${a},[1])`, `linearsolutionspace(${a},[[1],[2]])`,
    `component(rowreduce(${a}),0,1)`, `component(rowreduce(${a}),1.5,1)`,
    `component(rowreduce(${a}),3,1)`, `component(linearsolve(${a},[1,2]),1,1)`,
    'qrq([[sqrt(2),1],[2]])', 'luu([[sqrt(2),true]])',
    'characteristiccoefficients([[sqrt(2),1]])', 'eigenspace([[sqrt(2),1]],sqrt(2))',
    `component(characteristiccoefficients(${a}),4)`,
    `component(qrq(${a}),1,3)`, `eigenspace(${a},[1])`, `eigenspace(${a},true)`,
    'eigenvalues([[sqrt(2),1]])', 'svdu([[sqrt(2),1],[0]])', 'svds([[sqrt(2),true]])',
    'component(singularvalues([[sqrt(2),1]]),2)', 'component(svdu([[sqrt(2),1]]),2,1)',
    'component(svdv([[sqrt(2)],[1]]),2,1)',
  ])('有理数でない成分に続く不正な入力を送らない: %s', async source => {
    const value = await evaluate(source);
    expect(value.engine).not.toHaveBeenCalled();
    expect(value.result.evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it('既存の有理数の連立式は追加計算を起動しない', async () => {
    const value = await evaluate('component(linearsolve([[2,1],[1,-1]],[5,1]),1)');
    expect(value.engine).not.toHaveBeenCalled();
    expect(value.result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 2 });
  });
  it('零空間の空の基底を数値0や解なしの集合へ変えない', async () => {
    const value = await evaluate('nullspace([[sqrt(2),0],[0,1]])',
      { ...scalar, kind: 'vector', expression: { kind: 'operation', operation: 'list', operands: [] } });
    expect(value.engine).toHaveBeenCalledOnce();
    expect(value.result.evaluation).toMatchObject({ status: 'value', kind: 'vector',
      expression: { operation: 'list', operands: [] } });
  });
  it('実際の基底にない成分の拒否を数値へ変えない', async () => {
    const value = await evaluate(`component(nullspace(${a}),2,1)`,
      { status: 'invalid', reason: 'domain', coordinateAuthorized: false });
    expect(value.engine).toHaveBeenCalledOnce();
    expect(value.result.evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
});
