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
  { source: 're(component(dft([1,2,3,4]),2))', value: -2 },
  { source: 'im(component(dft([1,2,3,4]),2))', value: 2 },
  { source: 'im(component(fft([1,2,3,4]),2))', value: 2 },
  { source: 're(component(idft([1,2,3,4]),1))', value: 2.5 },
  { source: 'im(component(ifft([1,2,3,4]),2))', value: -0.5 },
  { source: 'component(ifft(fft([1,2,3,4])),3)', value: 3 },
  { source: 'component(idft(dft([1,0,0])),1)', value: 1 },
  { source: 'im(component(dft([1,2,3]),2))', value: Math.sqrt(3) / 2 },
  { source: 'component(dft([1,2,3,4]),1)', value: 10 },
  { source: 're(component(fft([1+i,2,3,4]),2))', value: -2 },
  { source: 'im(component(fft([1+i,2,3,4]),2))', value: 3 },
  { source: 're(component(dft([1/3,2/3]),1))', value: 1 },
  { source: 'im(component(dft([i/10^100]),1))*10^100', value: 1 },
  { source: 'dft([1,2,3,4])', kind: 'vector' },
  { source: 'component(dft([1,2,3,4]),2)', kind: 'complex' },
  { source: '0*re(component(dft([1,1/0]),1))', reason: 'domain' },
  { source: 'component(dft([1,1/0]),1)', reason: 'domain' },
  { source: 'fft([1,2,3])', reason: 'domain' },
  { source: 'ifft([1,2,3])', reason: 'domain' },
  { source: 'dft([])', reason: 'domain' },
  { source: 'dft([[1,2],[3,4]])', reason: 'domain' },
  { source: 'component(dft([1,2]),0)', reason: 'domain' },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_fourier_test.py', import.meta.url));
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`離散変換の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
function request(source: string, angleUnit: 'degree' | 'radian' = 'degree'): MathWorkRequest {
  return { source, notation: 'text', angleUnit, coefficients: [],
    identity: { documentId: 'fourier', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(example => {
    const input = request(example.source);
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${example.source}`);
    return { expression: reply.expression, angleUnit: input.angleUnit };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 75_000);

describe('離散変換は符号・倍率・元の全要素を保って保存する', () => {
  it('直接和・逆変換・複素数・厳密値・入力上限を独立に照合する', () => { native([]); }, 75_000);
  it.each(examples)('$sourceの公開入力と保存を確認する', async example => {
    const input = request(example.source);
    const evaluate = vi.fn(() => Promise.resolve(results[examples.indexOf(example)]));
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(2, input), {
      backend, engine: { evaluate }, shouldStop: () => undefined,
    });
    const decode = (value: unknown) => decodeMathWorkReply(value, input, {
      operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    }).result;
    const result = decode(raw);
    expect(evaluate).toHaveBeenCalledOnce();
    if ('reason' in example) {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    } else {
      if ('value' in example) {
        expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
        if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result));
        expect(result.evaluation.coordinate).toBeCloseTo(example.value, 12);
        expect(result.evaluation.exact).not.toBeNull();
      } else {
        expect(result.evaluation).toMatchObject({ status: 'value', kind: example.kind });
        expect(result.evaluation).not.toHaveProperty('coordinate');
      }
      expect(result.definition).toMatchObject({ source: input.source, angleUnit: 'degree' });
      if (result.definition === null) throw new Error('保存する式がありません。');
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
      const reopened = await executeExactMathWorkRequest(saved, { backend, engine: { evaluate }, shouldStop: () => undefined });
      expect(decode(reopened).evaluation).toEqual(result.evaluation);
    }
  });
  it.each([0, 2, 4, 6, 13])('例%sを構造入力へ変えても変換方式を保つ', async index => {
    const input = request(examples[index].source);
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), {
      backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined,
    });
    if (reply.presentation === undefined || reply.presentation === null || reply.expression === null) {
      throw new Error(`表示変換がありません: ${JSON.stringify(reply)}`);
    }
    expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
  });
  it('中止済みなら追加計算を開始しない', async () => {
    const evaluate = vi.fn(() => Promise.resolve(results[0]));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(5, request(examples[0].source)), {
      backend, engine: { evaluate }, shouldStop: () => 'cancelled',
    });
    expect(reply.evaluation).toEqual({ status: 'stopped', reason: 'cancelled' });
    expect(evaluate).not.toHaveBeenCalled();
  });
});
