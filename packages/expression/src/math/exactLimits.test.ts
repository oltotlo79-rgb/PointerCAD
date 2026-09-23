import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';

const examples = [
  { source: 'limit((t^2-1)/(t-1),t,1)', value: 2, angleUnit: 'degree' },
  { source: 'limit(sin(t)/t,t,0)', value: Math.PI/180, angleUnit: 'degree' },
  { source: 'limit(sin(t)/t,t,0)', value: 1, angleUnit: 'radian' },
  { source: 'limit((1-cos(t))/sin(t)^2,t,0)', value: 0.5, angleUnit: 'radian' },
  { source: 'limit(abs(t)/t,t,0,-1)', value: -1, angleUnit: 'degree' },
  { source: 'limit(abs(t)/t,t,0,1)', value: 1, angleUnit: 'degree' },
  { source: 'limit(1/t,t,∞)', value: 0, angleUnit: 'degree' },
  { source: 'limit(atan(t),t,-∞)', value: -90, angleUnit: 'degree' },
  { source: 'limit(t*sin(1/t),t,0)', value: 0, angleUnit: 'radian' },
  { source: 'limit(t/t,t,0)', value: 1, angleUnit: 'degree' },
  { source: 'limit(abs(t)/t,t,0)', reason: 'no-limit', angleUnit: 'degree' },
  { source: 'limit(1/t,t,0)', reason: 'no-limit', angleUnit: 'degree' },
  { source: 'limit(sin(1/t),t,0)', reason: 'no-limit', angleUnit: 'radian' },
  { source: '0*limit(abs(t)/t,t,0)', reason: 'no-limit', angleUnit: 'degree' },
  { source: 'limit(1/t,t,0,1)', reason: 'non-finite', angleUnit: 'degree' },
  { source: 'limit(1/t^2,t,0)', reason: 'non-finite', angleUnit: 'degree' },
  { source: 'limit(t,t,0,2)', reason: 'domain', angleUnit: 'degree' },
  { source: 'limit(t,t,0,1/2)', reason: 'domain', angleUnit: 'degree' },
  { source: 'limit((t^2-1)/(t-1),t,1,0)', value: 2, angleUnit: 'degree' },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_limits_test.py', import.meta.url));
function request(source: string, angleUnit: 'degree' | 'radian' = 'degree'): MathWorkRequest {
  return { source, notation: 'text', angleUnit, coefficients: [],
    identity: { documentId: 'limit', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnSync('python', ['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`極限の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(({ source, angleUnit }) => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request(source, angleUnit)), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${source}`);
    return { expression: reply.expression, angleUnit };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 60_000);

describe('極限の左右と元の近傍条件を確認し、方向と単位を原式に保存する', () => {
  it('実計算部で独立な恒等式と近傍・左右・振動・角度単位を照合する', () => { native([]); }, 60_000);

  it.each(examples)('$angleUnit: $sourceの通常入力・返信・保存を照合する', async example => {
    const input = request(example.source, example.angleUnit), index = examples.indexOf(example);
    const evaluate = vi.fn(() => Promise.resolve(results[index]));
    const envelope = createMathWorkEnvelope(2, input);
    const initial = executeMathWorkRequest(envelope, backend);
    expect(initial.evaluation.status).not.toBe('value');
    const raw = await executeExactMathWorkRequest(envelope, { backend, engine: { evaluate }, shouldStop: () => undefined });
    const decode = (value: unknown) => decodeMathWorkReply(value, input, {
      operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    });
    const result = decode(raw).result;
    expect(evaluate).toHaveBeenCalledOnce();
    if ('value' in example) {
      expect(result.evaluation.status).toBe('value');
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null) {
        throw new Error('有限の実数と保存する原式が必要です。');
      }
      expect(result.evaluation.coordinate).toBeCloseTo(example.value, 12);
      expect(result.evaluation.exact).not.toBeNull();
      expect(result.definition).toMatchObject({ source: example.source, angleUnit: example.angleUnit });
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
      const reopened = await executeExactMathWorkRequest(saved, { backend, engine: { evaluate }, shouldStop: () => undefined });
      expect(decode(reopened).result.evaluation).toEqual(result.evaluation);
    } else {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
      expect(result.evaluation).not.toHaveProperty('coordinate');
      if (example.reason === 'no-limit') {
        if (raw.evaluation.status !== 'invalid') throw new Error('極限がない理由が必要です。');
        expect(raw.evaluation.detail).toContain('左右から近づけた値');
      }
    }
  });

  it.each([0, 4, 5, 18])('例%sの方向を構造入力とテキストの往復でも失わない', async index => {
    const example = examples[index], input = request(example.source, example.angleUnit);
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), {
      backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined,
    });
    if (reply.presentation === undefined || reply.presentation === null || reply.expression === null) throw new Error('表示変換がありません。');
    expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
    if (index === 4) expect(reply.presentation.source).toContain('^{-}');
    if (index === 5) expect(reply.presentation.source).toContain('^{+}');
    const restored = await executeExactMathWorkRequest(createMathWorkEnvelope(5, { ...input, source: reply.presentation.source,
      notation: 'latex', definition: reply.presentation, presentationNotation: 'text' }), {
      backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined,
    });
    if (restored.presentation === undefined || restored.presentation === null) throw new Error('テキスト表記へ戻せません。');
    expect(sameMathMeaning(reply.expression, restored.presentation.expression)).toBe(true);
    expect(restored.evaluation).toEqual(reply.evaluation);
  });

  it.each([
    ['limit(abs(t)/t,t,0,-1)', 'limit(abs(t)/t,t,0,1)'],
    ['limit(abs(t)/t,t,0,-1)', 'limit(abs(t)/t,t,0)'],
    ['limit(t,t,0,2)', 'limit(t,t,0)'],
    ['limit(t,t,0,1/2)', 'limit(t,t,0)'],
    ['limit(t,t,0,-1)', 'limit(t+1,t,0,-1)'],
    ['limit(t,t,0,-1)', 'limit(t,t,1,-1)'],
  ])('%sと%sの違いを方向の表記差として消さない', (left, right) => {
    const a = executeMathWorkRequest(createMathWorkEnvelope(6, request(left)), backend).expression;
    const b = executeMathWorkRequest(createMathWorkEnvelope(7, request(right)), backend).expression;
    if (a === null || b === null) throw new Error('比較する極限の原式が必要です。');
    expect(sameMathMeaning(a, b)).toBe(false);
  });
});
