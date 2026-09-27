import { decodeExactMathResult } from './exactMathResult.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  { source: 'solvesystem([x+y=3,x-y=1],[x,y],ℝ)', kind: 'equation-system' },
  { source: 'solvesystem([x+y=2],[x,y],ℝ)', kind: 'equation-system' },
  { source: 'solvesystem([x+y=2,x+y=3],[x,y],ℝ)', kind: 'equation-system' },
  { source: 'solvesystem([x^2=1,y=x],[x,y],ℝ)', kind: 'equation-system' },
  { source: 'solvesystem([x^2=-1,y=x],[x,y],ℂ)', kind: 'equation-system' },
  { source: 'solvesystem([x*y=1],[x,y],ℝ)', kind: 'equation-system' },
  { source: 'solvesystem([0*(1/x)=0,y=x],[x,y],ℝ)', kind: 'equation-system' },
  { source: 'solvesystem([x=x],[x,y],ℝ)', kind: 'equation-system' },
  { source: 'solvesystem([x^2+y^2=1],[x,y],ℝ)', kind: 'equation-system' },
  { source: 'component(systemsolution(solvesystem([x+y=3,x-y=1],[x,y],ℝ),1,[]),1)', value: 2 },
  { source: 'component(systemsolution(solvesystem([x+y=3,x-y=1],[y,x],ℝ),1,[]),1)', value: 1 },
  { source: 'component(systemsolution(solvesystem([x+y=2],[x,y],ℝ),1,[3]),1)', value: -1 },
  { source: 'component(systemsolution(solvesystem([x^2=1,y=x],[x,y],ℝ),2,[]),2)', value: 1 },
  { source: 'im(component(systemsolution(solvesystem([x^2=-1,y=x],[x,y],ℂ),1,[]),1))', value: -1 },
  { source: 'systemsolution(solvesystem([x+y=2],[x,y],ℝ),1,[])', reason: 'dimension' },
  { source: 'systemsolution(solvesystem([x+y=2],[x,y],ℝ),2,[3])', reason: 'domain' },
  { source: 'systemsolution(solvesystem([x*y=1],[x,y],ℝ),1,[0])', reason: 'domain' },
  { source: '0*component(systemsolution(solvesystem([x*y=1],[x,y],ℝ),1,[0]),1)', reason: 'domain' },
  { source: 'systemsolution(solvesystem([x+y=2,x+y=3],[x,y],ℝ),1,[])', reason: 'domain' },
  { source: 'solvesystem([cos(x)=x,y=x],[x,y],ℝ)', unresolved: true },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
function native(args: readonly string[], input?: string): string {
  const script = fileURLToPath(new URL('./exactRuntime/cas_equation_systems_test.py', import.meta.url));
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], { input, encoding: 'utf8',
    timeout: 180_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`方程式の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'equation-systems', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(example => {
    const input = request(example.source), reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${example.source}`);
    return { expression: reply.expression, angleUnit: input.angleUnit };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 190_000);

describe('連立式の未知数順序・自由変数・条件と明示した解を保持する', () => {
  it('元の穴・解なし・自由変数・非線形の全候補と複素数を独立に照合する', () => { native([]); }, 190_000);
  it.each(examples)('$sourceを公開入口で計算し保存できる', async example => {
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
    } else if ('kind' in example) expect(result.evaluation).toMatchObject({ status: 'value', kind: example.kind });
    else if ('reason' in example) expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
    else expect(result.evaluation).toMatchObject({ status: 'unresolved', reason: 'unevaluated' });
  });
  it.each(examples.slice(0, 8))('$sourceを構造入力と往復しても変数・範囲・比較記号を保つ', example => {
    const original = executeMathWorkRequest(createMathWorkEnvelope(3, request(example.source)), backend);
    const presentation = executeMathWorkRequest(createMathWorkEnvelope(4, { ...request(example.source), presentationNotation: 'latex' }), backend);
    expect(presentation.presentation).not.toBeNull();
    if (presentation.presentation === null || presentation.presentation === undefined || original.expression === null) throw new Error('表示がありません');
    expect(sameMathMeaning(original.expression, presentation.presentation.expression)).toBe(true);
    const restored = executeMathWorkRequest(createMathWorkEnvelope(5, { ...request(presentation.presentation.source), notation: 'latex' }), backend);
    if (restored.expression === null) throw new Error('構造入力を読めません');
    expect(sameMathMeaning(original.expression, restored.expression)).toBe(true);
  });
  it('中止済みの依頼で計算部を起動しない', async () => {
    const evaluate = vi.fn(() => Promise.resolve(results[0]));
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(6, request(examples[0].source)), {
      backend, engine: { evaluate }, shouldStop: () => 'cancelled',
    });
    expect(reply.evaluation).toEqual({ status: 'stopped', reason: 'cancelled' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('未知数と同名の係数を計算に代入しても保存する参照を変えない', async () => {
    const input: MathWorkRequest = { ...request('solvesystem([x+y=coef("x")],[x,y],ℝ)'),
      coefficients: [{ id: 'width', label: 'x', decimal: '5' }] };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(8, input), {
      backend, shouldStop: () => undefined, engine: { evaluate: (expression, angleUnit) => {
        const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify([{ expression, angleUnit }])));
        if (!Array.isArray(decoded) || decoded.length !== 1) throw new Error('返信数が不正です');
        return Promise.resolve(decoded[0]);
      } },
    });
    const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
      coefficientIds: new Set(['width']), declaredIds: new Set() }).result;
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'equation-system', expression: result.definition?.expression });
    expect(result.definition?.source).toBe(input.source);
  }, 190_000);
});

describe('連立式の返信を元の束縛範囲へ閉じる', () => {
  function source() {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(20, request(examples[1].source)), backend);
    if (reply.expression === null) throw new Error('式がありません');
    return reply.expression;
  }
  const context = () => ({ operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() });
  it.each([
    ['自由変数の重複', (value: Record<string, unknown>) => {
      const solutions = value.solutions as { branches: { parameters: string[] }[] };
      solutions.branches[0].parameters.push(...solutions.branches[0].parameters);
    }],
    ['未知の自由変数', (value: Record<string, unknown>) => {
      const solutions = value.solutions as { branches: { parameters: string[] }[] };
      solutions.branches[0].parameters = ['foreign'];
    }],
    ['範囲のすり替え', (value: Record<string, unknown>) => {
      const solutions = value.solutions as { domain: string }; solutions.domain = 'complex';
    }],
    ['元の式のすり替え', (value: Record<string, unknown>) => { value.request = { kind: 'number', decimal: '2' }; }],
    ['座標への無断適用', (value: Record<string, unknown>) => { value.coordinateAuthorized = true; }],
    ['不要な追加項目', (value: Record<string, unknown>) => { value.extra = 'not allowed'; }],
  ] as const)('%sを拒否する', (_, mutate) => {
    const value = structuredClone(results[1]) as Record<string, unknown>;
    mutate(value);
    expect(() => decodeExactMathResult(value, source(), context())).toThrow();
  });
  it('自由変数の読み取り処理を返信データとして実行しない', () => {
    const value = structuredClone(results[1]) as Record<string, unknown>;
    let read = false;
    Object.defineProperty(value, 'solutions', { enumerable: true, get() { read = true; throw new Error('getter'); } });
    expect(() => decodeExactMathResult(value, source(), context())).toThrow();
    expect(read).toBe(false);
  });
  it('通常の返信へ自由変数を漏らして専用検査を迂回できない', () => {
    const value = structuredClone(results[1]) as { solutions: { branches: { formula: { body: unknown } }[] } };
    expect(() => decodeExactMathResult({ status: 'value', kind: 'vector',
      expression: value.solutions.branches[0].formula.body, domainConditions: [], coordinateAuthorized: false }, source(), context())).toThrow();
  });
});
