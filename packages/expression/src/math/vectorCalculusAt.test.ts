import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  { source: 'component(gradientat(x^2*y,[x,y],[2,3]),1)', value: 12 },
  { source: 'component(gradientat(x^2*y,[y,x],[3,2]),1)', value: 4 },
  { source: 'divergenceat([x*y,x^2],[x,y],[2,3])', value: 3 },
  { source: 'component(curlat([-y,x,0],[x,y,z],[2,3,4]),3)', value: 2 },
  { source: 'laplacianat(x^2*y,[x,y],[2,3])', value: 6 },
  { source: 'component(jacobianat([x*y,x^2],[x,y],[2,3]),2,1)', value: 4 },
  { source: 'component(hessianat(x^2*y,[x,y],[2,3]),1,2)', value: 4 },
  { source: 'component(component(hessianat(x^2*y,[x,y],[2,3]),1),2)', value: 4 },
  { source: 'component(gradientat(5,[x,y],[2,3]),1)', value: 0 },
  { source: 'component(gradientat(sin(x),[x],[0]),1)', value: Math.PI / 180 },
  { source: 'component(gradientat(sin(x),[x],[0]),1)', value: 1, unit: 'radian' },
  { source: 'component(hessianat(cos(x),[x],[0]),1,1)', value: -((Math.PI / 180) ** 2) },
  { source: 'component(gradientat(ln(x),[x],[2]),1)', value: 0.5 },
  { source: 'component(gradientat(1/x,[x],[2]),1)', value: -0.25 },
  { source: 'component(gradientat(abs(x),[x],[-2]),1)', value: -1 },
  { source: 'component(gradientat(x·y,[x,y],[2,3]),1)', value: 3 },
  { source: 'component(gradientat(x*x,[x],[3]),1) × 2', value: 12 },
  { source: 'component(gradientat(x/x,[x],[0]),1)', invalid: 'domain' },
  { source: 'component(gradientat(x*y/(x^2+y^2),[x,y],[0,0]),1)', invalid: 'domain' },
  { source: 'component(jacobianat([x,y/y],[x,y],[2,0]),1,1)', invalid: 'domain' },
  { source: '0*component(jacobianat([x,y/y],[x,y],[2,0]),1,1)', invalid: 'domain' },
  { source: 'component(gradientat(component([x,y/y],1),[x,y],[2,0]),1)', invalid: 'domain' },
  { source: 'component(gradientat(x,[x],[i]),1)', invalid: 'domain' },
  { source: 'component(gradientat(x,[x],[∞]),1)', invalid: 'domain' },
  { source: 'component(gradientat(i*x,[x],[2]),1)', invalid: 'domain' },
  { source: 'component(gradientat(abs(x),[x],[0]),1)', unresolved: true },
  { source: 'component(gradientat(sqrt(x),[x],[0]),1)', unresolved: true },
  { source: 'component(gradientat(0*abs(x),[x],[0]),1)', unresolved: true },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_vector_calculus_test.py', import.meta.url));
function request(source: string, unit: 'degree' | 'radian' = 'degree'): MathWorkRequest {
  return { source, notation: 'text', angleUnit: unit, coefficients: [],
    identity: { documentId: 'vector-at', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`指定位置のベクトル解析に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(example => {
    const input = request(example.source, 'unit' in example ? example.unit : 'degree');
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${example.source}: ${JSON.stringify(reply.evaluation)}`);
    return { expression: reply.expression, angleUnit: input.angleUnit };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 75_000);

describe('指定位置の直交座標の微分を、全成分の成立条件を保って座標へ渡す', () => {
  it('同名の局所変数と係数IDを区別し、係数と評価点の変更を原式のまま反映する', async () => {
    const source = 'component(gradientat(coef("x")*x^2,[x],[coef("位置")]),1)';
    const engine = sharedExactEngine(batch => native(['--batch'], batch));
    const calculated = await Promise.all(([['3', '2', 12], ['5', '3', 30]] as const).map(async ([factor, point, expected]) => {
      const input: MathWorkRequest = { ...request(source), coefficients: [
        { id: 'factor-id', label: 'x', decimal: factor }, { id: 'point-id', label: '位置', decimal: point },
      ] };
      return { input, expected,
        raw: await executeExactMathWorkRequest(createMathWorkEnvelope(7, input), { backend, engine, shouldStop: () => undefined }) };
    }));
    const reopenedRuns = await Promise.all(calculated.map(async ({ input, expected, raw }) => {
      const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
        coefficientIds: new Set(['factor-id', 'point-id']), declaredIds: new Set() }).result;
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      expect(result.definition?.source).toBe(source);
      if (result.definition === null) throw new Error('保存する原式がありません。');
      const reopened: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(8, { ...input, definition: result.definition })));
      return { result, again: await executeExactMathWorkRequest(reopened, { backend, engine, shouldStop: () => undefined }) };
    }));
    for (const { result, again } of reopenedRuns) expect(again.evaluation).toEqual(result.evaluation);
  });
  it('6方式・変数順序・右手系と、元の穴・近傍不明を実計算で独立に検証する', () => { native([]); }, 75_000);
  it.each(examples)('$sourceの通常入力・保存・再評価', async example => {
    const input = request(example.source, 'unit' in example ? example.unit : 'degree');
    const envelope = createMathWorkEnvelope(2, input);
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
      expect(result.evaluation).toMatchObject('invalid' in example
        ? { status: 'invalid', reason: example.invalid } : { status: 'unresolved', reason: 'unevaluated' });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
  });
  it.each([0, 2, 3, 4, 5, 6, 15])('方式%sの変数順序・評価点と原式を表示切替で保つ', async index => {
    const input = request(examples[index].source);
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), {
      backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined,
    });
    if (reply.presentation === undefined || reply.presentation === null || reply.expression === null) throw new Error(JSON.stringify(reply));
    expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
    const back = executeMathWorkRequest(createMathWorkEnvelope(5, { ...input, source: reply.presentation.source,
      notation: 'latex', definition: reply.presentation, presentationNotation: 'text' }), backend);
    expect(back.presentation?.expression).toBeDefined();
    if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(reply.expression, back.presentation.expression)).toBe(true);
  });
  it.each([
    'gradientat(x,[x,x],[1,2])', 'gradientat(x,[x],[1,2])', 'gradientat(x,[],[])',
    'gradientat(x,[x,y,z,t],[1,2,3,4])', 'curlat([x,y],[x,y],[1,2])',
    'jacobianat([[x,y]],[x,y],[1,2])', 'gradientat([x,y],[x,y],[1,2])',
    'component(gradientat(x,[x],[1]),2)', 'component(hessianat(x,[x],[1]),1) × 2',
  ])('%sは次元・変数の指定を誤ったまま計算しない', source => {
    const result = executeMathWorkRequest(createMathWorkEnvelope(6, request(source)), backend);
    expect(result.evaluation.status).toBe('invalid');
    expect(result.evaluation).not.toHaveProperty('coordinate');
  });
});
