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
  { source: 'fourierseries(x,x,-pi,pi,2)', kind: 'fourier-series' },
  { source: 'fourierseries(x^2,x,-pi,pi,2)', kind: 'fourier-series' },
  { source: 'fourierseries(abs(x),x,-pi,pi,1)', kind: 'fourier-series' },
  { source: 'fourierat(fourierseries(x,x,-pi,pi,2),pi/2)', value: 2 },
  { source: 'fourierat(fourierseries(x,x,-pi,pi,2),5*pi/2)', value: 2 },
  { source: 'fouriercos(fourierseries(3,x,-pi,pi,0),0)', value: 6 },
  { source: 'fouriersin(fourierseries(3,x,-pi,pi,0),0)', value: 0 },
  { source: 'fouriersin(fourierseries(x,x,-pi,pi,2),2)', value: -1 },
  { source: 'fouriercos(fourierseries(x^2,x,-pi,pi,2),1)', value: -4 },
  { source: 'fourierat(fourierseries(sin(x),x,-180,180,1),90)', value: 1 },
  { source: 'fourierseries(x,x,0,0,1)', reason: 'domain' },
  { source: 'fourierseries(x,x,2,1,1)', reason: 'domain' },
  { source: 'fourierseries(x,x,0,∞,1)', reason: 'domain' },
  { source: 'fourierseries(x,x,0,1,-1)', reason: 'domain' },
  { source: 'fourierseries(x,x,0,1,13)', stopped: true },
  { source: 'fouriercos(fourierseries(x,x,-pi,pi,1),2)', reason: 'domain' },
  { source: 'fourierat(fourierseries(x,x,-pi,pi,1),i)', reason: 'domain' },
  { source: '0*fourierat(fourierseries(1/x,x,-1,1,1),1)', reason: 'divergent' },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_fourier_series_test.py', import.meta.url));
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`フーリエ級数の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'fourier-series', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
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
}, 190_000);

describe('フーリエ級数の原式・周期区間・係数と部分和を区別する', () => {
  it('独立した係数・数値積分・角度・端点と元の極を実計算で照合する', () => { native([]); }, 190_000);
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
      if (result.evaluation.status === 'value' && result.evaluation.kind === 'fourier-series') {
        expect(result.evaluation.expression).toEqual(result.definition?.expression);
        expect(result.evaluation.series.convention).toBe('real-harmonics-radian');
        expect(result.evaluation.series.cosine).toHaveLength(Number(result.evaluation.series.degree));
      }
    } else if ('reason' in example) expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
    else expect(result.evaluation).toEqual({ status: 'stopped', reason: 'budget' });
  });
  it.each(examples.slice(0, 4))('$sourceを構造入力と往復しても意味を保つ', example => {
    const original = executeMathWorkRequest(createMathWorkEnvelope(3, request(example.source)), backend);
    const presentation = executeMathWorkRequest(createMathWorkEnvelope(4, { ...request(example.source), presentationNotation: 'latex' }), backend);
    expect(presentation.presentation).not.toBeNull();
    if (presentation.presentation === null || presentation.presentation === undefined || original.expression === null) throw new Error('表示がありません');
    expect(sameMathMeaning(original.expression, presentation.presentation.expression)).toBe(true);
    const restored = executeMathWorkRequest(createMathWorkEnvelope(5, { ...request(presentation.presentation.source), notation: 'latex' }), backend);
    expect(restored.expression).not.toBeNull();
    if (restored.expression === null) throw new Error('構造入力を読めません');
    expect(sameMathMeaning(original.expression, restored.expression)).toBe(true);
  });
  it('別の区間・係数数・未宣言文字・偽の収束規約を持つ返信を拒否する', () => {
    const expression = executeMathWorkRequest(createMathWorkEnvelope(1, request(examples[0].source)), backend).expression;
    if (expression === null) throw new Error('入力がありません');
    const context = { operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
    const copy = () => JSON.parse(JSON.stringify(results[0])) as { request: unknown; series: { convention: string; degree: string; constant: unknown } };
    const changed = copy(); changed.request = null;
    expect(() => decodeExactMathResult(changed, expression, context)).toThrow();
    const degree = copy(); degree.series.degree = '12';
    expect(() => decodeExactMathResult(degree, expression, context)).toThrow();
    const rule = copy(); rule.series.convention = 'degree';
    expect(() => decodeExactMathResult(rule, expression, context)).toThrow();
    const symbol = copy(); symbol.series.constant = { kind: 'symbol', reference: { role: 'axis', name: 'X' } };
    expect(() => decodeExactMathResult(symbol, expression, context)).toThrow();
  });
  it('係数を代入して計算しても元の係数参照を保存する', async () => {
    const input: MathWorkRequest = { ...request('fourierseries(coef("幅")*x,x,-pi,pi,2)'), coefficients: [{ id: 'width', label: '幅', decimal: '1' }] };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(6, input), {
      backend,
      engine: { evaluate: expression => {
        const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify([{ expression, angleUnit: 'degree' }])));
        if (!Array.isArray(decoded) || decoded.length !== 1) throw new Error('計算の返信数が一致しません。');
        return Promise.resolve(decoded[0]);
      } },
      shouldStop: () => undefined,
    });
    const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById, coefficientIds: new Set(['width']), declaredIds: new Set() }).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'fourier-series', expression: result.definition?.expression });
    expect(result.definition?.source).toBe(input.source);
  }, 190_000);
  it('中止済みの依頼で計算部を起動しない', async () => {
    const evaluate = vi.fn(() => Promise.resolve(results[0]));
    const result = await executeExactMathWorkRequest(createMathWorkEnvelope(7, request(examples[0].source)), {
      backend, engine: { evaluate }, shouldStop: () => 'cancelled',
    });
    expect(result.evaluation).toEqual({ status: 'stopped', reason: 'cancelled' }); expect(evaluate).not.toHaveBeenCalled();
  });
});
