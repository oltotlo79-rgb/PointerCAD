import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathEvaluation, decodeMathWorkReply } from './mathWorkReply.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import type { MathNode } from './mathInputContract.js';

const examples = [
  { source: 'sup(interval(open(0),open(1)))', value: 1 },
  { source: 'inf(interval(open(0),open(1)))', value: 0 },
  { source: 'setmax(interval(open(0),1))', value: 1 },
  { source: 'setmin(interval(0,open(1)))', value: 0 },
  { source: 'setmax(set(1,3,2,3))', value: 3 },
  { source: 'setmin(set(1/3,sqrt(2),π))', value: 1/3 },
  { source: 'sup(union(interval(0,2),interval(4,5)))', value: 5 },
  { source: 'inf(intersection(interval(0,2),interval(1,3)))', value: 1 },
  { source: 'sup(setminus(interval(0,2),set(2)))', value: 2 },
  { source: 'inf(ℕ)', value: 0 },
  { source: 'setmax(intersection(ℤ,interval(open(0),open(4))))', value: 3 },
  { source: '2*sup(interval(open(0),4))+1', value: 9 },
  { source: 'sup(ℕ)', bound: 'positive' },
  { source: 'inf(ℤ)', bound: 'negative' },
  { source: 'sup(ℝ)', bound: 'positive' },
  { source: 'setmax(interval(0,open(1)))', reason: 'no-extremum' },
  { source: 'setmin(interval(open(0),1))', reason: 'no-extremum' },
  { source: 'setmax(ℕ)', reason: 'no-extremum' },
  { source: 'sup(∅)', reason: 'empty-set' },
  { source: 'inf(intersection(interval(0,1),interval(2,3)))', reason: 'empty-set' },
  { source: 'sup(set(i))', reason: 'domain' },
  { source: 'sup(set(1/0))', reason: 'domain' },
  { source: '0*setmax(interval(0,open(1)))', reason: 'no-extremum' },
  { source: '1/sup(ℕ)', reason: 'non-finite' },
  { source: '0*sup(ℝ)', reason: 'non-finite' },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_sets_test.py', import.meta.url));
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'set-bounds', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnSync('python', ['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`集合の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
const context = () => ({ operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() });
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(({ source }) => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request(source)), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${source}: ${JSON.stringify(reply.evaluation)}`);
    return { expression: reply.expression, angleUnit: 'radian' };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 60_000);

describe('集合の上下限と極値を区別し、有限の値だけを座標へ渡す', () => {
  it('実計算部で開閉・順序・無限・未定義を独立な集合の性質と照合する', () => { native([]); }, 60_000);

  it.each(examples)('$sourceの実計算・公開返信・保存を照合する', async example => {
    const input = request(example.source), index = examples.indexOf(example);
    const options = { backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(2, input), options);
    const result = decodeMathWorkReply(raw, input, context()).result;
    if ('reason' in example) {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
      expect(result.evaluation).not.toHaveProperty('coordinate');
      return;
    }
    if ('value' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result.evaluation));
      expect(result.evaluation.coordinate).toBeCloseTo(example.value, 12);
      expect(result.evaluation.exact).not.toBeNull();
    } else {
      const infinity: MathNode = { kind: 'constant', name: 'infinity' };
      expect(result.evaluation).toEqual({ status: 'value', kind: 'infinite-bound', expression:
        example.bound === 'positive' ? infinity : { kind: 'operation', operation: 'negate', operands: [infinity] } });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
    expect(result.definition?.source).toBe(example.source);
    if (result.definition === null) throw new Error('保存する原式がありません。');
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
    const reopened = await executeExactMathWorkRequest(saved, options);
    expect(decodeMathWorkReply(reopened, input, context()).result.evaluation).toEqual(result.evaluation);
  });

  it.each([0,1,2,3,6,12,13])('例%sの上下限と開閉を構造入力の往復でも保持する', async index => {
    const input = request(examples[index].source);
    const options = { backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), options);
    if (raw.presentation === undefined || raw.presentation === null || raw.expression === null) throw new Error('構造入力がありません。');
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    const restored = await executeExactMathWorkRequest(createMathWorkEnvelope(5, { ...input, source: raw.presentation.source,
      notation: 'latex', definition: raw.presentation, presentationNotation: 'text' }), options);
    if (restored.presentation === undefined || restored.presentation === null) throw new Error(`テキスト入力へ戻せません: ${JSON.stringify(restored)}`);
    expect(sameMathMeaning(raw.expression, restored.presentation.expression)).toBe(true);
    expect(restored.evaluation).toEqual(raw.evaluation);
  });

  it('無限の結果の種類に有限値や無関係な入力を混ぜた返信を拒否する', () => {
    const number: MathNode = { kind: 'number', decimal: '1' };
    expect(() => decodeMathEvaluation({ status: 'value', kind: 'infinite-bound', expression: number }, context())).toThrow();
    expect(() => decodeExactMathResult({ status: 'value', kind: 'infinite-bound',
      expression: { kind: 'constant', name: 'infinity' }, domainConditions: [], coordinateAuthorized: false }, number, context())).toThrow();
  });
});
