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
  { source: 'derivativeat(t^3,t,2)', value: 12 },
  { source: 'derivativeat(t^3,t,2,2)', value: 12 },
  { source: 'derivativeat(t^3,t,2,3)', value: 6 },
  { source: 'derivativeat(t^3,t,2,15)', value: 0 },
  { source: 'derivativeat(sin(t),t,0)', value: Math.PI / 180 },
  { source: 'derivativeat(sin(t),t,0)', value: 1, unit: 'radian' },
  { source: 'derivativeat(cos(t),t,0,2)', value: -((Math.PI / 180) ** 2) },
  { source: 'derivativeat(ln(t),t,2)', value: 0.5 },
  { source: 'derivativeat(1/t,t,2,2)', value: 0.25 },
  { source: 'derivativeat(abs(t),t,2)', value: 1 },
  { source: 'derivativeat(abs(t),t,-2)', value: -1 },
  { source: 'derivativeat(abs(t),t,0)', reason: 'domain' },
  { source: 'derivativeat(sqrt(t),t,0)', reason: 'domain' },
  { source: 'derivativeat(t/t,t,0)', reason: 'domain' },
  { source: 'derivativeat((t^2-1)/(t-1),t,1)', reason: 'domain' },
  { source: '0*derivativeat(abs(t),t,0)', reason: 'domain' },
  { source: 'derivativeat(abs(t),t,0)-derivativeat(abs(t),t,0)', reason: 'domain' },
  { source: 'derivativeat(derivativeat(x^2*y,x,2),y,3)', value: 4 },
  { source: 'derivativeat(t,t,2,0)', reason: 'domain' },
  { source: 'derivativeat(t,t,2,-1)', reason: 'domain' },
  { source: 'derivativeat(t,t,2,1.5)', reason: 'domain' },
  { source: 'derivativeat(t,t,2,16)', reason: 'domain' },
  { source: 'derivativeat(t,t,∞)', reason: 'domain' },
  { source: 'derivativeat(0*ln(t),t,0)', reason: 'domain' },
  { source: 'derivativeat(0*abs(t),t,0)', value: 0 },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py', import.meta.url));
function request(example: typeof examples[number]): MathWorkRequest {
  return { source: example.source, notation: 'text', angleUnit: 'unit' in example ? example.unit : 'degree', coefficients: [],
    identity: { documentId: 'derivative', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnSync('python', ['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`微分の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(example => {
    const input = request(example);
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${example.source}`);
    return { expression: reply.expression, angleUnit: input.angleUnit };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 75_000);

describe('指定位置の微分は元の定義域と左右の傾きから確かめる', () => {
  it('高階・角度・尖点・元の穴・入れ子を独立な厳密値と比較する', () => { native([]); }, 75_000);
  it.each(examples)('$sourceの通常入力・返信・保存を照合する', async example => {
    const input = request(example), envelope = createMathWorkEnvelope(2, input);
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
      expect(result.definition).toMatchObject({ source: example.source, angleUnit: input.angleUnit });
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
      const reopened = await executeExactMathWorkRequest(saved, { backend, engine: { evaluate }, shouldStop: () => undefined });
      expect(decode(reopened).evaluation).toEqual(result.evaluation);
    } else {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
  });
  it.each([0, 1, 4, 5, 17])('例%sの変数・位置・微分回数を構造入力への切替でも保つ', async index => {
    const input = request(examples[index]);
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), {
      backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined,
    });
    if (reply.presentation === undefined || reply.presentation === null || reply.expression === null) {
      throw new Error(`表示変換がありません: ${JSON.stringify(executeMathWorkRequest(createMathWorkEnvelope(5,
        { ...input, presentationNotation: 'latex' }), backend).evaluation)}`);
    }
    expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
  });
});
