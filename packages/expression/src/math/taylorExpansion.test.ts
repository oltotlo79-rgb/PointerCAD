import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathEvaluation, decodeMathWorkReply } from './mathWorkReply.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { coordinateFromMath, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';

let backend: MathExecutionBackend;
const script = fileURLToPath(new URL('./exactRuntime/cas_taylor_test.py', import.meta.url));
const examples = [
  { source: 'taylor(exp(x),x,0,3)', coefficients: ['1', '1', '1/2', '1/6'], convergence: 'entire', exact: false },
  { source: 'maclaurin(1/(1-x),x,4)', coefficients: ['1', '1', '1', '1', '1'], convergence: 'disk', exact: false },
  { source: 'taylor(1/x,x,1,3)', coefficients: ['1', '-1', '1', '-1'], convergence: 'disk', exact: false },
  { source: 'taylor(x^3,x,2,4)', coefficients: ['8', '12', '6', '1', '0'], convergence: 'entire', exact: true },
  { source: 'taylor(ln(x),x,1,3)', coefficients: ['0', '1', '-1/2', '1/3'], convergence: 'unknown', exact: false },
  { source: 'maclaurin(sin(x),x,3)', coefficients: ['0', '1', '0', '-1/6'], convergence: 'entire', exact: false },
] as const;
function native(args: readonly string[], input?: string): string {
  const result = spawnSync('python', ['-B', '-X', 'utf8', script, ...args], { input, encoding: 'utf8',
    timeout: 90_000, maxBuffer: 2_000_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
  if (result.status !== 0 || result.error !== undefined) throw new Error(`${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'series', documentVersion: 1, editorId: 'X', inputRevision: 1 } };
}
const engine = { evaluate(expression: MathNode, angleUnit: 'degree' | 'radian'): Promise<unknown> {
  const values: unknown = JSON.parse(native(['--batch'], JSON.stringify([{ expression, angleUnit }])));
  if (!Array.isArray(values) || values.length !== 1) throw new Error('展開結果の数が一致しません。');
  return Promise.resolve(values[0]);
} };
beforeAll(() => { backend = createMathBackend(); });
const context = () => ({ operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() });

describe('Taylor展開の係数・打切り・収束を元の関数の値と区別する', () => {
  it('独立した階乗・二項展開・角度・元の定義域・複素極・資源上限を確認する', () => { native([]); }, 105_000);
  it.each(examples)('$sourceを実計算し、保存・構造入力の往復でも意味を保つ', async example => {
    const input = { ...request(example.source), presentationNotation: 'latex' as const };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(1, input), { backend, engine, shouldStop: () => undefined });
    const result = decodeMathWorkReply(raw, input, context()).result;
    if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'series' || result.definition === null) throw new Error(JSON.stringify(result));
    const expansion = result.evaluation.expansion;
    expect(expansion.coefficients.map(node => {
      const value = rationalOfExpression(node); if (value === null) throw new Error(JSON.stringify(node));
      return value.denominator === 1n ? String(value.numerator) : `${value.numerator}/${value.denominator}`;
    })).toEqual(example.coefficients);
    expect(expansion.convergence.kind).toBe(example.convergence);
    expect(expansion.exact).toBe(example.exact);
    expect(() => coordinateFromMath(result.evaluation)).toThrow();
    expect(result.evaluation).not.toHaveProperty('coordinate');
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...input, definition: result.definition })));
    const reopened = await executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined });
    expect(reopened.evaluation).toEqual(result.evaluation);
    if (raw.expression === null || raw.presentation === undefined || raw.presentation === null) throw new Error('構造入力がありません。');
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    const back = executeMathWorkRequest(createMathWorkEnvelope(3, { ...input, source: raw.presentation.source,
      notation: 'latex', definition: raw.presentation, presentationNotation: 'text' }), backend);
    if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(raw.expression, back.presentation.expression)).toBe(true);
  }, 30_000);
  it.each(['taylor((x-1)/(x-1),x,1,3)', 'taylor(abs(x),x,0,3)', 'taylor(1/x,x,0,0)',
    'taylor(x,x,0,-1)', 'taylor(x,x,0,1/2)', 'taylor(x,x,0,13)', 'taylor(x,[x],0,3)',
    '0*taylor(x,x,0,3)', 'component([1,taylor(1/x,x,0,3)],1)'])('%sを座標へ使わない', async source => {
    const result = await executeExactMathWorkRequest(createMathWorkEnvelope(4, request(source)), { backend, engine, shouldStop: () => undefined });
    expect(result.evaluation.status).not.toBe('value');
    expect(result.evaluation).not.toHaveProperty('coordinate');
  });
  it('係数を使っても保存する元の式と局所変数を保持し、係数変更だけを結果へ反映する', async () => {
    for (const decimal of ['2', '3']) {
      const input: MathWorkRequest = { ...request('taylor(x+coef("x"),x,coef("中心"),2)'), coefficients: [
        { id: 'offset', label: 'x', decimal }, { id: 'center', label: '中心', decimal: '1' }] };
      const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(7, input), { backend, engine, shouldStop: () => undefined });
      const result = decodeMathWorkReply(raw, input, { ...context(), coefficientIds: new Set(['offset', 'center']) }).result;
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'series') throw new Error(JSON.stringify(result));
      expect(result.definition?.source).toBe(input.source);
      expect(rationalOfExpression(result.evaluation.expansion.coefficients[0])?.numerator).toBe(BigInt(decimal) + 1n);
    }
  });
  it('返答の次数・中心の差替え、局所変数の流出、数値権限の追加を拒否する', async () => {
    const input = request('taylor(x^3,x,2,3)'), parsed = executeMathWorkRequest(createMathWorkEnvelope(5, input), backend);
    if (parsed.expression === null) throw new Error(JSON.stringify(parsed));
    const original: unknown = await engine.evaluate(parsed.expression, input.angleUnit);
    if (original === null || typeof original !== 'object' || !('expansion' in original)
      || original.expansion === null || typeof original.expansion !== 'object') throw new Error(JSON.stringify(original));
    const expression = parsed.expression, expansion = original.expansion;
    for (const replacement of [{ degree: '2', remainderOrder: '3' }, { center: { kind: 'number', decimal: '3' } },
      { coefficients: [{ kind: 'symbol', reference: { role: 'bound', id: 'forged', label: 'x' } }] },
      { remainderOrder: '2' }, { convergence: { kind: 'disk', radius: { kind: 'number', decimal: '-1' } } }]) {
      expect(() => decodeExactMathResult({ ...original, expansion: { ...expansion, ...replacement } }, expression, context())).toThrow();
    }
    expect(() => decodeExactMathResult({ ...original, coordinateAuthorized: true }, expression, context())).toThrow();
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(6, input), { backend, engine, shouldStop: () => undefined });
    expect(() => decodeMathEvaluation({ ...reply.evaluation, coordinate: 8 }, context())).toThrow();
  });
});
