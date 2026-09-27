import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';

describe('単位行列と零行列の追加計算部', () => {
  it('大きさ1〜16、拒否条件、独立な I·A=A を確認する', () => {
    const script = fileURLToPath(new URL('./exactRuntime/cas_matrix_constructors_test.py', import.meta.url));
    const result = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`行列の生成と独立な恒等式の確認に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    }
  });

  it('生成した行列から画面の tensorelement と component で成分を選んで座標に使い、範囲外の添字は理由付きで拒否する', async () => {
    const engine = sharedExactEngine(exactRuntimeBatch(fileURLToPath(new URL('./exactRuntime/cas_mappings_test.py', import.meta.url)), 90_000));
    const backend = createMathBackend();
    const request = (source: string): MathWorkRequest => ({ source, notation: 'text', angleUnit: 'radian', coefficients: [],
      identity: { documentId: 'matrix-constructors', documentVersion: 1, editorId: 'component', inputRevision: 1 } });
    const values = [['component(identitymatrix(3),1,1)', 1], ['tensorelement(identitymatrix(3),[2,3])', 0],
      ['component(zeromatrix(2,3),2,3)', 0], ['tensorelement(zeromatrix(2),[1,2])', 0]] as const;
    const outside = ['component(identitymatrix(3),4,1)', 'tensorelement(zeromatrix(2,3),[1,4])', 'tensorelement(identitymatrix(2),[1])'];
    const replies = await Promise.all([...values.map(([source]) => source), ...outside].map(source => executeExactMathWorkRequest(
      createMathWorkEnvelope(1, request(source)), { backend, engine, shouldStop: () => undefined })));
    values.forEach(([source, coordinate], index) => {
      expect(replies[index]?.evaluation, source).toMatchObject({ status: 'value', kind: 'real', coordinate });
    });
    for (const reply of replies.slice(values.length)) {
      expect(reply.evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
      expect(reply.evaluation).not.toHaveProperty('coordinate');
    }
  }, 105_000);
});
