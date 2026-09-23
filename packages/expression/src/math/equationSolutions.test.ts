import { beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';

const examples = [
  { source: 'solve(x^2=1,x,ℝ)', kind: 'set' },
  { source: 'solve(1/x>0,x,ℝ)', kind: 'interval' },
  { source: 'solve(x/x=1,x,ℝ)', kind: 'set' },
  { source: 'solve(x=x,x,ℝ)', kind: 'set' },
  { source: 'solve(x=x,x,ℂ)', kind: 'set' },
  { source: 'solve(sqrt(x)=-1,x,ℝ)', kind: 'set' },
  { source: 'solve((x^2-1)/(x-1)=2,x,ℝ)', kind: 'set' },
  { source: 'solve(x^2=-1,x,ℂ)', kind: 'set' },
  { source: 'solution(solve(x^2=4,x,ℝ),1)', value: -2 },
  { source: 'solution(solve(x^2=4,x,ℝ),2)', value: 2 },
  { source: 'solution(solve(x^2=1,x,interval(open(-1),1)),1)', value: 1 },
  { source: 'solution(solve(sin(x)=1,x,interval(0,180)),1)', value: 90 },
  { source: 'im(solution(solve(x^2=-1,x,ℂ),1))', value: -1 },
  { source: 'polynomialroots((x-1)^2*(x+2),x,ℂ)', kind: 'matrix' },
  { source: 'component(polynomialroots((x-1)^2*(x+2),x,ℂ),2,2)', value: 2 },
  { source: 'solution(solve(x^2=1,x,ℝ),0)', reason: 'domain' },
  { source: 'solution(solve(x^2=1,x,ℝ),3)', reason: 'domain' },
  { source: 'solution(solve(sqrt(x)=-1,x,ℝ),1)', reason: 'domain' },
  { source: 'solve(x=0,x,interval(2,1))', reason: 'domain' },
  { source: 'solve(cos(x)=x,x,ℝ)', unresolved: true },
  { source: '0*solution(solve(cos(x)=x,x,ℝ),1)', unresolved: true },
  { source: 'solve(sin(x)>0,x,ℝ)', unresolved: true },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
function native(args: readonly string[], input?: string): string {
  const script = fileURLToPath(new URL('./exactRuntime/cas_equations_test.py', import.meta.url));
  const result = spawnSync('python', ['-B', '-X', 'utf8', script, ...args], { input, encoding: 'utf8',
    timeout: 180_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`方程式の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'degree', coefficients: [],
    identity: { documentId: 'equations', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
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

describe('方程式の元の条件・解集合と明示した解を保持する', () => {
  it('元の穴・解なし・不等式の境界・複素数と重根を独立な値で照合する', () => { native([]); }, 190_000);
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
});
