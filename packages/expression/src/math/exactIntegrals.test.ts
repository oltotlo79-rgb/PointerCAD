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
  { source: 'integrate(1/sqrt(t),t,0,1)', value: 2 },
  { source: 'integrate(ln(t),t,0,1)', value: -1 },
  { source: 'integrate((t^2-1)/(t-1),t,0,2)', value: 4 },
  { source: 'integrate((t^2-1)/(t-1),t,2,0)', value: -4 },
  { source: 'integrate(t/t,t,-1,1)', value: 2 },
  { source: 'integrate(1/(1+t^2),t,-∞,∞)', value: Math.PI },
  { source: 'integrate(exp(-t),t,0,∞)', value: 1 },
  { source: 'integrate(1/t^2,t,1,∞)', value: 1 },
  { source: 'integrate(1/t,t,-1,1)', reason: 'divergent' },
  { source: 'integrate(1/t^2,t,-1,1)', reason: 'divergent' },
  { source: 'integrate(1/t,t,0,1)', reason: 'divergent' },
  { source: 'integrate(1/t,t,1,∞)', reason: 'divergent' },
  { source: '0*integrate(1/t,t,-1,1)', reason: 'divergent' },
  { source: 'integrate(1/t,t,-1,1)-integrate(1/t,t,-1,1)', reason: 'divergent' },
  { source: 'integrate(integrate(t*exp(-u),u,0,∞),t,1,2)', value: 1.5 },
  { source: 'integrate(integrate(t*exp(-u),u,0,∞),t,2,1)', value: -1.5 },
  { source: 'integrate(0*integrate(t*exp(u),u,0,∞),t,1,2)', unresolved: true },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_integrals_test.py', import.meta.url));
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'integral', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`積分の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
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

describe('積分の元の定義域と片側ごとの収束を確認してから座標へ渡す', () => {
  it('実計算部で端点・内部の極・無限区間・入れ子・角度を独立な値と照合する', () => { native([]); }, 75_000);

  it.each(examples)('$sourceの通常入力・返信・保存を照合する', async example => {
    const input = request(example.source), envelope = createMathWorkEnvelope(2, input);
    const evaluate = vi.fn(() => Promise.resolve(results[examples.indexOf(example)]));
    expect(executeMathWorkRequest(envelope, backend).evaluation.status).not.toBe('value');
    const raw = await executeExactMathWorkRequest(envelope, { backend, engine: { evaluate }, shouldStop: () => undefined });
    const decode = (value: unknown) => decodeMathWorkReply(value, input, {
      operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    }).result;
    const result = decode(raw);
    expect(evaluate).toHaveBeenCalledOnce();
    if ('value' in example) {
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.evaluation.coordinate).toBeCloseTo(example.value, 12);
      expect(result.evaluation.exact).not.toBeNull();
      expect(result.definition).toMatchObject({ source: example.source, angleUnit: 'degree' });
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
      const reopened = await executeExactMathWorkRequest(saved, { backend, engine: { evaluate }, shouldStop: () => undefined });
      expect(decode(reopened).evaluation).toEqual(result.evaluation);
    } else if ('unresolved' in example) {
      expect(result.evaluation).toMatchObject({ status: 'unresolved', reason: 'unevaluated' });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    } else {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
  });

  it.each([0, 1, 2, 5])('例%sの積分範囲・原式を構造入力への切替でも保持する', async index => {
    const input = request(examples[index].source);
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), {
      backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined,
    });
    if (reply.presentation === undefined || reply.presentation === null || reply.expression === null) throw new Error('表示変換がありません。');
    expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
  });
});
