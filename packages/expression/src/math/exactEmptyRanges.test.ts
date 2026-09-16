import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });

describe('追加計算部でも空の範囲の和は0・積は1を保つ', () => {
  it.each([
    ['sum(k,k,5,1)', 0], ['product(k,k,5,1)', 1],
    ['sum(k,k,2,1)', 0], ['product(k,k,2,1)', 1],
    ['sum(k,k,4,4)', 4], ['product(k,k,4,4)', 4],
    ['sum(k,k,-3,2)', -3], ['product(k,k,-3,2)', 0],
    ['sum(sum(j,j,3,i),i,1,3)', 3], ['product(product(j,j,3,i),i,1,3)', 3],
    ['integrate(k,k,3,1)', -4],
  ] as const)('通常の入力経路でも%sが%sとなる', (source, expected) => {
    const request: MathWorkRequest = { source, notation: 'text', angleUnit: 'degree', coefficients: [],
      identity: { documentId: 'range', documentVersion: 1, editorId: 'coordinate-X', inputRevision: 1 } };
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request), backend);
    expect(reply.source).toBe(source);
    expect(reply.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
  });
  it('直接の数え上げと照合し、積分の逆向きの符号は変えない', () => {
    const script = fileURLToPath(new URL('./exactRuntime/cas_empty_ranges_test.py', import.meta.url));
    const result = spawnSync('python', ['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    if (result.error !== undefined || result.status !== 0 || !/Ran 4 tests in/u.test(result.stderr)) {
      throw new Error(`和・積の範囲の照合に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    }
  });
});
