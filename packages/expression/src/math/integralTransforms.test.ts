import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  { source: 'fourier(exp(-x^2),x,k)', kind: 'transform' },
  { source: 'inversefourier(exp(-pi*x^2),x,t)', kind: 'transform' },
  { source: 'laplace(exp(-x),x,s)', kind: 'transform' },
  { source: 'inverselaplace(1/(x+1),x,t)', kind: 'transform' },
  { source: 'ztransform((1/2)^n,n,z)', kind: 'transform' },
  { source: 'transformat(fourier(exp(-x^2),x,k),0)', value: Math.sqrt(Math.PI) },
  { source: 'transformat(inversefourier(exp(-pi*x^2),x,t),1)', value: Math.exp(-Math.PI) },
  { source: 'transformat(laplace(exp(-x),x,s),1)', value: 0.5 },
  { source: 'transformat(inverselaplace(1/(x+1),x,t),1)', value: Math.exp(-1) },
  { source: 'transformat(ztransform((1/2)^n,n,z),2)', value: 4/3 },
  { source: 're(transformat(laplace(exp(-x),x,s),1+i))', value: 0.4 },
  { source: 'im(transformat(laplace(exp(-x),x,s),1+i))', value: -0.2 },
  { source: 'transformat(laplace(exp(-x),x,s),-1)', reason: 'domain' },
  { source: 'transformat(laplace(exp(-x),x,s),-2)', reason: 'domain' },
  { source: 'transformat(inverselaplace(1/(x+1),x,t),0)', reason: 'domain' },
  { source: 'transformat(ztransform((1/2)^n,n,z),1/2)', reason: 'domain' },
  { source: 'transformat(ztransform((1/2)^n,n,z),0)', reason: 'domain' },
  { source: '0*transformat(laplace(1/0,x,s),1)', reason: 'domain' },
  { source: 'fourier(1,x,k)', unresolved: true },
  { source: 'inverselaplace(1,x,t)', unresolved: true },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_transforms_test.py', import.meta.url));
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`連続変換の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'transforms', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
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
}, 130_000);

describe('連続変換は符号・変数・成立範囲を保持して利用する', () => {
  it('独立積分・正逆変換・複素数・元の穴と領域を実計算で照合する', () => { native([]); }, 130_000);
  it.each(examples)('$sourceの公開入力と保存を確認する', async example => {
    const input = request(example.source);
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(2, input), {
      backend, engine: { evaluate: () => Promise.resolve(results[examples.indexOf(example)]) }, shouldStop: () => undefined,
    });
    const decode = (value: unknown) => decodeMathWorkReply(value, input, {
      operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    }).result;
    const result = decode(raw);
    expect(decode(JSON.parse(JSON.stringify(raw)))).toEqual(result);
    expect(result.definition?.source).toBe(example.source);
    if ('value' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
      if (result.evaluation.status === 'value' && result.evaluation.kind === 'real') {
        expect(result.evaluation.coordinate).toBeCloseTo(example.value, 12);
        expect(result.evaluation.approximation).toBeNull();
      }
    } else if ('kind' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: example.kind });
      if (result.evaluation.status === 'value' && result.evaluation.kind === 'transform') {
        expect(result.evaluation.expression).toEqual(result.definition?.expression);
        expect(result.evaluation.transform.condition.bindings).toEqual(result.evaluation.transform.formula.bindings);
      }
    } else if ('reason' in example) expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
    else expect(result.evaluation.status).toBe('unresolved');
  });
  it.each(examples.slice(0, 5))('$sourceを構造入力と往復しても変数と意味を保つ', example => {
    const original = executeMathWorkRequest(createMathWorkEnvelope(3, request(example.source)), backend);
    const presentation = executeMathWorkRequest(createMathWorkEnvelope(4, { ...request(example.source), presentationNotation: 'latex' }), backend);
    expect(presentation.presentation).not.toBeNull();
    if (presentation.presentation === null || presentation.presentation === undefined || original.expression === null) throw new Error('変換表示がありません');
    expect(sameMathMeaning(original.expression, presentation.presentation.expression)).toBe(true);
    const restored = executeMathWorkRequest(createMathWorkEnvelope(5, { ...request(presentation.presentation.source), notation: 'latex' }), backend);
    expect(restored.expression).not.toBeNull();
    if (restored.expression === null) throw new Error('構造入力を読めません');
    expect(sameMathMeaning(original.expression, restored.expression)).toBe(true);
  });
  it('別の変数や規約を持つ返信を拒否する', () => {
    const expression = executeMathWorkRequest(createMathWorkEnvelope(1, request(examples[2].source)), backend).expression;
    if (expression === null) throw new Error('入力がありません');
    const context = { operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
    const source = results[2];
    const altered = JSON.parse(JSON.stringify(source)) as { transform: { convention: string } };
    altered.transform.convention = 'fourier-cycles';
    expect(() => decodeExactMathResult(altered, expression, context)).toThrow();
    const changed = JSON.stringify(source).replaceAll('"label":"s"', '"label":"wrong"');
    expect(() => decodeExactMathResult(JSON.parse(changed), expression, context)).toThrow();
  });
  it.each(['fourier(exp(-x^2),x,x)', 'fourier(exp(-x*k),x,k)'])('%sの変数の混同を拒否する', source => {
    const result = executeMathWorkRequest(createMathWorkEnvelope(6, request(source)), backend);
    expect(result.evaluation.status).toBe('invalid');
  });
  it('中止済みの依頼で追加の計算部を起動しない', async () => {
    const evaluate = vi.fn(() => Promise.resolve(results[0]));
    const result = await executeExactMathWorkRequest(createMathWorkEnvelope(7, request(examples[0].source)), {
      backend, engine: { evaluate }, shouldStop: () => 'cancelled',
    });
    expect(result.evaluation).toEqual({ status: 'stopped', reason: 'cancelled' }); expect(evaluate).not.toHaveBeenCalled();
  });
});
