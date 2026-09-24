import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  { source: 'sum((1/2)^k,k,0,∞)', value: 2 },
  { source: 'sum((1/2)^k,k,0,∞,2)', value: 4/3 },
  { source: 'sum(1/k^2,k,1,∞)', value: Math.PI**2/6 },
  { source: 'sum((-1)^(k+1)/k,k,1,∞)', value: Math.log(2) },
  { source: 'product(4*k^2/(4*k^2-1),k,1,∞)', value: Math.PI/2 },
  { source: 'product(1-1/k^2,k,2,∞)', value: 0.5 },
  { source: 'sum(1/k,k,1,∞)', reason: 'divergent' },
  { source: 'sum((-1)^k,k,0,∞)', reason: 'divergent' },
  { source: 'product(k/(k+1),k,1,∞)', reason: 'divergent' },
  { source: 'sum(1/(k-3)^2,k,1,∞)', reason: 'domain' },
  { source: 'sum(((k-3)/(k-3))*(1/2)^k,k,1,∞)', reason: 'domain' },
  { source: 'product(1-1/k^2,k,1,∞)', reason: 'domain' },
  { source: '0*sum(1/k,k,1,∞)', reason: 'divergent' },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_infinite_ranges_test.py', import.meta.url));
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'series', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`無限の和・積の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(({ source }) => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request(source)), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${source}`);
    return { expression: reply.expression, angleUnit: 'degree' };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 75_000);

describe('無限の和・積は全項の成立条件と収束を確認してから座標へ渡す', () => {
  it('計算部で独立した恒等式・元の分母・極限・有限範囲の条件を照合する', () => { native([]); }, 75_000);

  it.each(examples)('$sourceの通常入力・返信・保存する原式を照合する', async example => {
    const input = request(example.source), index = examples.indexOf(example);
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
      expect(result.definition).toMatchObject({ source: example.source, angleUnit: 'degree' });
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
      const reopened = await executeExactMathWorkRequest(saved, { backend, engine: { evaluate }, shouldStop: () => undefined });
      expect(decode(reopened).result.evaluation).toEqual(result.evaluation);
    } else {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
      expect(result.evaluation).not.toHaveProperty('coordinate');
      if (example.reason === 'divergent') {
        expect(raw.evaluation.status).toBe('invalid');
        if (raw.evaluation.status !== 'invalid') throw new Error('収束しない理由が必要です。');
        expect(raw.evaluation.detail).toContain('収束しません');
      }
    }
  });

  it('無限端と刻み幅を構造入力へ変換しても原式の意味を保持する', async () => {
    const input = { ...request(examples[1].source), presentationNotation: 'latex' as const };
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, input), {
      backend, engine: { evaluate: () => Promise.resolve(results[1]) }, shouldStop: () => undefined,
    });
    expect(reply.presentation?.inputNotation).toBe('latex');
    if (reply.presentation === undefined || reply.presentation === null || reply.expression === null) throw new Error('表示変換がありません。');
    expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
    expect(reply.evaluation).toMatchObject({ status: 'value', kind: 'real' });
  });
});
