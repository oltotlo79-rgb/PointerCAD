import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  { source: 'odesolve([diff(y,x)=y],x,[y],[[y,0,2]])', kind: 'ode-solutions' },
  { source: 'odesolve([diff(y,x,x)=-y],x,[y],[[y,0,0],[diff(y,x),0,1]])', kind: 'ode-solutions' },
  { source: 'odesolve([diff(y,x)=2],x,[y],[])', kind: 'ode-solutions' },
  { source: 'odesolve([diff(y,x)=z,diff(z,x)=-y],x,[y,z],[[y,0,0],[z,0,1]])', kind: 'ode-solutions' },
  { source: 'component(odeat(odesolve([diff(y,x)=y],x,[y],[[y,0,2]]),1,[],ln(2)),1)', value: 4 },
  { source: 'component(odeat(odesolve([diff(y,x,x)=0],x,[y],[[y,0,2],[y,2,6]]),1,[],1),1)', value: 4 },
  { source: 'component(odeat(odesolve([diff(y,x)=2],x,[y],[]),1,[5],3),1)', value: 11 },
  { source: 'component(odeat(odesolve([diff(y,x,x)=-y],x,[y],[[y,0,0],[diff(y,x),0,1]]),1,[],pi/2),1)', value: 1 },
  { source: 'odeat(odesolve([diff(y,x)=2],x,[y],[]),1,[],3)', reason: 'dimension' },
  { source: 'odeat(odesolve([diff(y,x)=2],x,[y],[]),2,[5],3)', reason: 'domain' },
  { source: 'odeat(odesolve([diff(y,x)+0*(1/x)=1],x,[y],[[y,1,2]]),1,[],0)', reason: 'domain' },
  { source: 'odesolve([diff(y,x)=1],x,[y],[[y,0,0],[y,0,1]])', reason: 'domain' },
  { source: 'pde([diff(u,t)=diff(u,x,x)],[x,t],[u],[[u,[0,t],0]])', unresolved: true },
  { source: 'odesolve([diff(y,C1)=2],C1,[y],[])', kind: 'ode-solutions' },
  { source: 'odesolve([dy/dx=y],x,[y],[[y,0,2]])', kind: 'ode-solutions' },
  { source: 'component(odeat(odesolve([y″=0],x,[y],[[y,0,2],[y,2,6]]),1,[],1),1)', value: 4 },
  { source: "component(odeat(odesolve([y''=-y],x,[y],[[y,0,0],[y',0,1]]),1,[],pi/2),1)", value: 1 },
  { source: 'component(odeat(odesolve([y″=-y],x,[y],[[y,0,0],[y′,0,1]]),1,[],pi/2),1)', value: 1 },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
function native(args: readonly string[], input?: string): string {
  const script = fileURLToPath(new URL('./exactRuntime/cas_ode_test.py', import.meta.url));
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 180_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('微分方程式の実計算に失敗しました。\n' + (result.error?.message ?? '') + '\n' + result.stdout + '\n' + result.stderr);
  }
  return result.stdout;
}
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'differential-equations', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(example => {
    const input = request(example.source), reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    if (reply.expression === null) throw new Error('数式を読めません: ' + example.source + '\n' + JSON.stringify(reply.evaluation));
    return { expression: reply.expression, angleUnit: input.angleUnit };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('返信数が一致しません。');
  results = decoded;
}, 190_000);

describe('微分方程式の変数・初期値・境界値と明示した解候補を保持する', () => {
  it('一次・二階・連立・両端条件・元の穴を独立した答えと照合する', () => { native([]); }, 190_000);
  it.each(examples)('$sourceを公開入口と保存形式で保つ', async example => {
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
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: example.value, approximation: null });
    } else if ('kind' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: example.kind, solutions: { coverage: 'verified-branches' } });
    } else if ('reason' in example) expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
    else expect(result.evaluation).toMatchObject({ status: 'unresolved', reason: 'unevaluated' });
  });
  it.each([examples[0], examples[1], examples[3], examples[12]])('$sourceを構造入力と往復しても条件を保つ', example => {
    const input = request(example.source);
    const original = executeMathWorkRequest(createMathWorkEnvelope(3, input), backend);
    const rendered = executeMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), backend);
    if (rendered.presentation == null || original.expression === null) throw new Error('数式の表示がありません。');
    expect(sameMathMeaning(original.expression, rendered.presentation.expression)).toBe(true);
    const restored = executeMathWorkRequest(createMathWorkEnvelope(5, { ...input, notation: 'latex', source: rendered.presentation.source }), backend);
    if (restored.expression === null) throw new Error('構造入力を読めません。');
    expect(sameMathMeaning(original.expression, restored.expression)).toBe(true);
  });
  it.each([
    'odesolve([diff(y,x)=y],x,[x],[])',
    'odesolve([diff(y,y)=y],x,[y],[])',
    'odesolve([diff(y,x)=y],x,[y],[[x,0,1]])',
    'pde([diff(u,t)=diff(u,x,x)],[x,x],[u],[])',
  ])('不正な変数・条件 %sを拒否する', source => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(6, request(source)), backend);
    expect(reply.evaluation.status).toBe('invalid');
  });
  it('中止済みの依頼で計算部を起動しない', async () => {
    const evaluate = vi.fn(() => Promise.resolve(results[0]));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(7, request(examples[0].source)), {
      backend, engine: { evaluate }, shouldStop: () => 'cancelled',
    });
    expect(reply.evaluation).toEqual({ status: 'stopped', reason: 'cancelled' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('別の条件・定数のすり替えと全解への読み替えを返信時に拒否する', () => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(8, request(examples[0].source)), backend);
    if (reply.expression === null) throw new Error('元の式がありません。');
    const decode = (value: unknown) => decodeExactMathResult(value, reply.expression as NonNullable<typeof reply.expression>, {
      operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    });
    const valid = results[0];
    expect(decode(valid).status).toBe('value');
    const raw = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    expect(() => decode({ ...raw, coordinateAuthorized: true })).toThrow();
    expect(() => decode({ ...raw, request: results[1] })).toThrow();
    const solutions = raw.solutions as Record<string, unknown>;
    expect(() => decode({ ...raw, solutions: { ...solutions, coverage: 'all-solutions' } })).toThrow();
    const getter = vi.fn();
    expect(() => decode({ ...raw, solutions: Object.defineProperty({}, 'branches', { get: getter }) })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('元の式の有限性確認を省略した返信や別の変数で置き換えた返信を拒否する', () => {
    const parsed = executeMathWorkRequest(createMathWorkEnvelope(9, request(examples[0].source)), backend);
    if (parsed.expression === null) throw new Error('元の式がありません。');
    const expression = parsed.expression;
    const decode = (value: unknown) => decodeExactMathResult(value, expression, {
      operationsById: backend.operationsById, coefficientIds: new Set(), declaredIds: new Set(),
    });
    const raw = JSON.parse(JSON.stringify(results[0])) as Record<string, unknown>;
    const solutions = raw.solutions as { coverage: string; branches: Record<string, unknown>[] };
    const branch = solutions.branches[0];
    const withBranch = (value: Record<string, unknown>) => ({ ...raw, solutions: { ...solutions, branches: [value] } });
    const missing = { ...branch };
    delete missing.originals;
    expect(() => decode(withBranch(missing))).toThrow();
    const originals = branch.originals as Record<string, unknown>;
    expect(() => decode(withBranch({ ...branch, originals: { ...originals,
      body: { kind: 'operation', operation: 'list', operands: [
        { kind: 'symbol', reference: { role: 'bound', id: 'unrelated', label: 'x' } },
      ] },
    } }))).toThrow();
    const getter = vi.fn();
    expect(() => decode(withBranch(Object.defineProperty({ ...branch }, 'originals', { get: getter })))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
