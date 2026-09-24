import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { formatMathText } from './formatMathText.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';

const runtime = new URL('./exactRuntime/', import.meta.url);
const backend = createMathBackend();
const identity = { documentId: 'projection', documentVersion: 1, editorId: 'vector', inputRevision: 1 };
function request(source: string): MathWorkRequest {
  return { identity, source, notation: 'text', angleUnit: 'radian', coefficients: [] };
}

describe('実ベクトルの射影', () => {
  it('固定計算部の15件の独立した厳密値・恒等式・拒否条件を通す', () => {
    const script = fileURLToPath(new URL('cas_vector_projection_test.py', runtime));
    const result = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`射影の独立照合に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    }
    expect(result.stderr).toContain('Ran 15 tests');
  }, 105_000);

  it('通常入力から射影を計算し、選んだ成分を座標の数値に使う', async () => {
    const script = fileURLToPath(new URL('cas_mappings_test.py', runtime));
    const engine = sharedExactEngine(exactRuntimeBatch(script, 90_000));
    const vector = await executeExactMathWorkRequest(createMathWorkEnvelope(1, request('projection([1,2],[3,4])')),
      { backend, engine, shouldStop: () => undefined });
    expect(vector.evaluation).toMatchObject({ status: 'value', kind: 'vector' });
    const evaluation = vector.evaluation;
    if (evaluation.status !== 'value' || evaluation.kind !== 'vector'
      || evaluation.expression.kind !== 'operation' || evaluation.expression.operation !== 'list') {
      throw new Error(JSON.stringify(evaluation));
    }
    const sources = evaluation.expression.operands.map(component => formatMathText(component, backend.operationsById));
    const replies = await Promise.all(sources.map(source => executeExactMathWorkRequest(
      createMathWorkEnvelope(2, request(source)), { backend, engine, shouldStop: () => undefined })));
    expect(replies[0]?.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 33 / 25 });
    expect(replies[1]?.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 44 / 25 });
    for (const reply of replies) {
      if (reply?.evaluation.status !== 'value' || reply.evaluation.kind !== 'real') throw new Error(JSON.stringify(reply));
      expect(reply.evaluation.exact).not.toBeNull();
    }
  }, 105_000);

  it('計算した射影から画面の tensorelement と component で成分を選んで座標に使い、範囲外の添字は理由付きで拒否する', async () => {
    const script = fileURLToPath(new URL('cas_mappings_test.py', runtime));
    const engine = sharedExactEngine(exactRuntimeBatch(script, 90_000));
    const sources = ['tensorelement(projection([1,2],[3,4]),[1])', 'component(projection([1,2],[3,4]),2)',
      'tensorelement(projection([1,2],[3,4]),[3])', 'component(projection([1,2],[3,4]),1,1)'];
    const [first, second, ...outside] = await Promise.all(sources.map(source => executeExactMathWorkRequest(
      createMathWorkEnvelope(3, request(source)), { backend, engine, shouldStop: () => undefined })));
    expect(first?.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 33 / 25 });
    expect(second?.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 44 / 25 });
    for (const reply of [first, second]) {
      if (reply?.evaluation.status !== 'value' || reply.evaluation.kind !== 'real') throw new Error(JSON.stringify(reply));
      expect(reply.evaluation.exact).not.toBeNull();
    }
    for (const reply of outside) {
      expect(reply.evaluation.status).toBe('invalid');
      expect(reply.evaluation).toMatchObject({ reason: 'domain' });
      expect(reply.evaluation).not.toHaveProperty('coordinate');
    }
  }, 105_000);

  it('零ベクトル・次元違い・複素成分を計算結果にしない', async () => {
    const script = fileURLToPath(new URL('cas_mappings_test.py', runtime));
    const engine = sharedExactEngine(exactRuntimeBatch(script, 90_000));
    const sources = ['projection([1,2],[0,0])', 'projection([1,2],[1,2,3])', 'projection([1,i],[1,2])'];
    const replies = await Promise.all(sources.map(source => executeExactMathWorkRequest(
      createMathWorkEnvelope(2, request(source)), { backend, engine, shouldStop: () => undefined })));
    for (const reply of replies) {
      expect(reply.evaluation.status).not.toBe('value');
      expect(reply.evaluation).not.toHaveProperty('coordinate');
    }
  }, 105_000);
});
