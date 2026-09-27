import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import type { MathNode } from './mathInputContract.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  { source: 'limsup(sin(t)+cos(t),t,∞)', value: Math.SQRT2 },
  { source: 'liminf(sin(t)+cos(t),t,∞)', value: -Math.SQRT2 },
  { source: 'limsup(sin(1/t),t,0)', value: 1 },
  { source: 'liminf(sin(1/t),t,0)', value: -1 },
  { source: 'limsup(sin(t)+1/t,t,∞)', value: 1 },
  { source: 'liminf(sin(t)+1/t,t,∞)', value: -1 },
  { source: 'limsup(abs(t)/t,t,0)', value: 1 },
  { source: 'liminf(abs(t)/t,t,0)', value: -1 },
  { source: 'limsup(abs(t)/t,t,0,-1)', value: -1 },
  { source: 'liminf(abs(t)/t,t,0,1)', value: 1 },
  { source: 'limsup((-1)^n,n,∞,0,ℤ)', value: 1 },
  { source: 'liminf((-1)^n,n,∞,0,ℕ)', value: -1 },
  { source: 'limsup((-1)^n,n,-∞,0,ℤ)', value: 1 },
  { source: 'limsup(t/t,t,0)', value: 1 },
  { source: '2*limsup(sin(t),t,∞)+1', value: 3 },
  { source: 'limsup(1/t,t,0)', bound: 'positive' },
  { source: 'liminf(1/t,t,0)', bound: 'negative' },
  { source: '0*limsup(t,t,∞)', status: 'invalid', reason: 'non-finite' },
  { source: '1/limsup(t,t,∞)', status: 'invalid', reason: 'non-finite' },
  { source: 'limsup((-1)^n,n,∞)', status: 'unresolved', reason: 'unevaluated' },
  { source: 'limsup(sin(t),t,∞,0,ℂ)', status: 'invalid', reason: 'domain' },
  { source: 'limsup(n,n,-∞,0,ℕ)', status: 'invalid', reason: 'domain' },
  { source: 'limsup(n,n,0,0,ℤ)', status: 'invalid', reason: 'domain' },
  { source: 'limsup(t,t,∞,1)', status: 'invalid', reason: 'domain' },
  { source: 'limsup(t,t,0,2)', status: 'invalid', reason: 'domain' },
  { source: 'limsup(i/t,t,∞)', status: 'unresolved', reason: 'unevaluated' },
  { source: 'limsup(sin(t)/sin(t),t,∞)', status: 'unresolved', reason: 'unevaluated' },
  { source: 'limsup(tan(t),t,∞)', status: 'unresolved', reason: 'unevaluated' },
  { source: 'limit(sin(1/t),t,0)', status: 'invalid', reason: 'no-limit' },
  { source: 'limsup(4*(-1)^n,n,∞,0,ℤ)', value: 4 },
  { source: 'limsup(6*(-1)^n,n,∞,0,ℤ)', value: 6 },
  { source: 'limit(2*t,t,0)', value: 0 },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'limit-bounds', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
const context = () => ({ operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() });
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(({ source }) => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request(source)), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${source}: ${JSON.stringify(reply.evaluation)}`);
    return { expression: reply.expression, angleUnit: 'radian' };
  });
  // The existing native harness loads the very same runtime sources as the browser Worker.
  const script = fileURLToPath(new URL('./exactRuntime/cas_limits_test.py', import.meta.url));
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, '--batch'], {
    input: JSON.stringify(payloads), encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`上極限・下極限の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  const decoded: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 60_000);

describe('上極限・下極限は振動の上下と接近する範囲を保ち、有限値だけを座標へ渡す', () => {
  it.each(examples)('$sourceの実計算・公開返信・保存を独立な解析値と照合する', async example => {
    const input = request(example.source), index = examples.indexOf(example);
    const options = { backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(2, input), options);
    const result = decodeMathWorkReply(raw, input, context()).result;
    if ('reason' in example) {
      expect(result.evaluation).toMatchObject({ status: example.status, reason: example.reason });
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

  it.each([0, 1, 2, 6, 8, 9, 10, 11, 12, 15, 16, 29, 30, 31])('例%sの演算・方向・整数条件を表示往復でも保持する', async index => {
    const input = request(examples[index].source);
    const options = { backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), options);
    if (raw.presentation === undefined || raw.presentation === null || raw.expression === null) {
      const conversion = executeMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), backend);
      throw new Error(`構造入力がありません: ${JSON.stringify(conversion)}`);
    }
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    const restored = await executeExactMathWorkRequest(createMathWorkEnvelope(5, { ...input, source: raw.presentation.source,
      notation: 'latex', definition: raw.presentation, presentationNotation: 'text' }), options);
    if (restored.presentation === undefined || restored.presentation === null) throw new Error(`テキスト入力へ戻せません: ${JSON.stringify(restored)}`);
    expect(sameMathMeaning(raw.expression, restored.presentation.expression)).toBe(true);
    expect(restored.evaluation).toEqual(raw.evaluation);
  });

  it.each([
    ['limsup(sin(t),t,∞)', 'liminf(sin(t),t,∞)'],
    ['limsup(abs(t)/t,t,0,-1)', 'limsup(abs(t)/t,t,0,1)'],
    ['limsup((-1)^n,n,∞)', 'limsup((-1)^n,n,∞,0,ℤ)'],
    ['limsup(n,n,∞,0,ℕ)', 'limsup(n,n,∞,0,ℤ)'],
  ])('%sと%sの条件差を表示差と扱わない', (left, right) => {
    const a = executeMathWorkRequest(createMathWorkEnvelope(6, request(left)), backend).expression;
    const b = executeMathWorkRequest(createMathWorkEnvelope(7, request(right)), backend).expression;
    if (a === null || b === null) throw new Error('比較する原式がありません。');
    expect(sameMathMeaning(a, b)).toBe(false);
  });

  it('外側の演算に無限の返信を混ぜて座標用の計算を迂回できない', () => {
    const source = executeMathWorkRequest(createMathWorkEnvelope(8, request('1/limsup(t,t,∞)')), backend).expression;
    if (source === null) throw new Error('比較する原式がありません。');
    expect(() => decodeExactMathResult({ status: 'value', kind: 'infinite-bound',
      expression: { kind: 'constant', name: 'infinity' }, domainConditions: [], coordinateAuthorized: false }, source, context())).toThrow();
  });
});
