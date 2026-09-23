import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';

const examples: readonly (readonly [string, number])[] = [
  ['sum(k,k,1,10,2)', 25], ['product(k,k,1,10,2)', 945],
  ['sum(k,k,-5,5,3)', -2], ['product(k,k,-5,5,3)', 40],
  ['sum(k,k,4,4,7)', 4], ['product(k,k,4,4,7)', 4],
  ['sum(k,k,5,1,3)', 0], ['product(k,k,5,1,3)', 1],
  ['sum(sum(j,j,1,i,2),i,2,8,3)', 26],
];
let backend: MathExecutionBackend;
let nativeResults: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_step_ranges_test.py', import.meta.url));
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'range', documentVersion: 3, editorId: 'coordinate-X', inputRevision: 7 } };
}
function runNative(args: readonly string[], input?: string): string {
  const result = spawnSync('python', ['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`刻み幅の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(([source]) => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request(source)), backend);
    if (reply.expression === null) throw new Error(`数式を読み取れません: ${source}`);
    return { expression: reply.expression, angleUnit: 'degree' };
  });
  const decoded: unknown = JSON.parse(runNative(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('実計算の返信数が一致しません。');
  nativeResults = decoded;
}, 45_000);

describe('刻み幅のある和・積を原式のまま入力・保存・再評価する', () => {
  it('直接の数え上げで範囲・入れ子・空範囲・元の成立条件を独立に照合する', () => {
    runNative([]);
  }, 45_000);

  it.each(examples)('%sが%sとなり保存した原式で再評価できる', async (source, expected) => {
    const input = request(source), index = examples.findIndex(([value]) => value === source);
    const evaluate = vi.fn(() => Promise.resolve(nativeResults[index]));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(2, input), {
      backend, engine: { evaluate }, shouldStop: () => undefined,
    });
    const decode = (value: unknown, origin: MathWorkRequest) => decodeMathWorkReply(value, origin, {
      operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    });
    const result = decode(reply, input).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
    expect(result.definition).toMatchObject({ source, angleUnit: 'degree' });
    if (result.definition === null) throw new Error('保存する原式がありません。');
    const reopened: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
    const again = await executeExactMathWorkRequest(reopened, {
      backend, engine: { evaluate }, shouldStop: () => undefined,
    });
    expect(decode(again, input).result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
  });

  it.each(['sum(k,k,1,9,0)', 'sum(k,k,1,9,-1)', 'product(k,k,1,9,1/2)',
    'sum(k,k,1,9,i)', 'integrate(k,k,1,9,2)'])('不正な刻み幅を計算へ送らない: %s', async source => {
    const evaluate = vi.fn(() => Promise.resolve(nativeResults[0]));
    const result = await executeExactMathWorkRequest(createMathWorkEnvelope(4, request(source)), {
      backend, engine: { evaluate }, shouldStop: () => undefined,
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.evaluation.status).not.toBe('value');
  });

  it('構造入力への切替でも刻み幅と局所変数を保持する', async () => {
    const input = { ...request(examples[0][0]), presentationNotation: 'latex' as const };
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(5, input), {
      backend, engine: { evaluate: () => Promise.resolve(nativeResults[0]) }, shouldStop: () => undefined,
    });
    expect(reply.presentation?.inputNotation).toBe('latex');
    if (reply.presentation === undefined || reply.presentation === null || reply.expression === null) {
      throw new Error('刻み幅を含む式の表示変換が成立しません。');
    }
    expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
    expect(reply.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 25 });
  });
});
