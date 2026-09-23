import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { lowerLegendrePolynomial } from './legendrePolynomial.js';
import type { MathNode } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  return { source, angleUnit, notation: 'text' as const, coefficients: [],
    identity: { documentId: 'legendre', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}
function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  const input = request(source, angleUnit), raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
  return decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function value(source: string) {
  const result = evaluate(source).evaluation;
  if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
  return result.coordinate;
}
function recurrence(n: number, x: number): number {
  let previous = 1, current = x;
  if (n === 0) return previous;
  for (let k = 1; k < n; k++) [previous, current] = [current, ((2*k+1)*x*current-k*previous)/(k+1)];
  return current;
}
function tape(source: string) {
  const definition = createFunctionMathSource(source, 'text', 'radian', { axes: ['X'], parameters: [], coefficients: [] }, backend);
  return compileFunctionScalar(definition, ['X'], [], { backend, shouldStop: () => undefined });
}

describe('Legendre多項式は次数・正規化・元の引数と式を保持する', () => {
  it.each([
    ['legendre(0,7)', 1], ['legendre(1,2/3)', 2/3], ['legendre(2,0)', -0.5],
    ['legendre(3,1/2)', -7/16], ['legendre(4,0)', 3/8], ['legendre(4,2)', 443/8],
    ['legendre(128,1)', 1], ['legendre(127,-1)', -1], ['legendre(128,-1)', 1],
    ['re(legendre(2,i))', -2], ['im(legendre(3,i))', -4], ['legendre(2,cos(60))', -1/8],
    ['2*legendre(4,0)+1', 1.75],
  ] as const)('%sを独立な既知値と照合する', (source, expected) => { expect(value(source)).toBeCloseTo(expected, 12); });
  it('有理数係数の公式を、独立した三項漸化式で照合する', () => {
    for (const degree of [0, 1, 2, 3, 4, 7, 12, 24]) for (const x of [-0.8, -0.25, 0, 0.4, 0.9]) {
      expect(value(`legendre(${degree},${x})`)).toBeCloseTo(recurrence(degree, x), 11);
    }
  });
  it('倍率付きの構造表示・保存JSON・原式の戻りを同じ経路で確認する', () => {
    const source = '2*legendre(4,0)+1', input = { ...request(source), presentationNotation: 'latex' as const };
    const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
    expect(raw.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 1.75 });
    const result = decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    if (raw.expression === null || result.definition === null || raw.presentation === undefined || raw.presentation === null) throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    const back = executeMathWorkRequest({ kind: 'evaluate-math', serial: 2, request: { ...input,
      source: raw.presentation.source, notation: 'latex', definition: raw.presentation, presentationNotation: 'text' } }, backend);
    if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
    // Display conversion emits canonical text; the separately stored input stays original.
    expect(back.presentation.source).toBe('Add(Multiply(2,Legendre(4,0)),1)');
    expect(sameMathMeaning(raw.expression, back.presentation.expression)).toBe(true);
    expect(back.evaluation).toEqual(raw.evaluation);
    expect(result.definition.source).toBe(source);
    const saved: unknown = JSON.parse(JSON.stringify({ kind: 'evaluate-math', serial: 3, request: { ...input, definition: result.definition } }));
    const reopened = executeMathWorkRequest(saved, backend);
    expect(reopened.evaluation).toEqual(raw.evaluation);
    expect(reopened.source).toBe(source);
  });
  it.each(['legendre(-1,2)', 'legendre(1/2,2)', 'legendre(0,1/0)', '0*legendre(-1,2)',
    'legendre(0,true)', 'legendre(0,[1])', 'legendre(0,infinity)', 'legendre(0,sqrt(-1)^0/0)'])('%sの不成立を定数項や0倍で消さない', source => {
    expect(evaluate(source).evaluation.status).not.toBe('value');
  });
  it.each([
    ['legendre(-1,0)', 'Legendre多項式の次数は0以上の整数です。'],
    ['legendre(1/2,0)', 'Legendre多項式の次数は0以上の整数です。'],
    ['legendre(0,1/0)', '0では割れません。'],
    ['0*legendre(-1,0)', 'Legendre多項式の次数は0以上の整数です。'],
  ] as const)('%sを外部計算用の共通理由に置き換えず、具体的な理由で断る', (source, detail) => {
    expect(evaluate(source).evaluation).toEqual({ status: 'invalid', reason: 'domain', detail });
  });
  it('次数と展開サイズの上限を生成前に拒否する', () => {
    expect(evaluate('legendre(129,1)').evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
    const number = (n: number): MathNode => ({ kind: 'number', decimal: String(n) });
    const argument: MathNode = { kind: 'operation', operation: 'add', operands: Array.from({ length: 70 }, (_, i) => number(i)) };
    expect(() => lowerLegendrePolynomial({ kind: 'operation', operation: 'legendre', operands: [number(128), argument] })).toThrow('上限');
  });
  it('関数作図の値と一階・二階微分を独立なP4の式で確認する', () => {
    const compiled = tape('legendre(4,X)'), sample = createScalarSampler(compiled), derivative = createScalarDirectionalJet(compiled, [1]);
    for (const x of [-1, -0.75, -0.3, 0, 0.2, 0.8, 1]) {
      expect(sample([x])).toBeCloseTo((35*x**4-30*x*x+3)/8, 13);
      const jet = derivative([{ lower: x, upper: x }]);
      const first = (140*x**3-60*x)/8, second = (420*x*x-60)/8;
      if (jet.first === null || jet.second === null) throw new Error(JSON.stringify(jet));
      expect(jet.first.lower).toBeLessThanOrEqual(first); expect(jet.first.upper).toBeGreaterThanOrEqual(first);
      expect(jet.second.lower).toBeLessThanOrEqual(second); expect(jet.second.upper).toBeGreaterThanOrEqual(second);
    }
  });
  it('P0でも元の穴を保持し、原点をまたぐ区間を連続と扱わない', () => {
    const compiled = tape('legendre(0,1/X)'), sample = createScalarSampler(compiled);
    expect(sample([1])).toBe(1); expect(Number.isFinite(sample([0]))).toBe(false);
    expect(createScalarIntervalSampler(compiled)([{ lower: -1, upper: 1 }]).continuous).toBe(false);
  });
  it('固定計算部の式・級数・微分へ渡しても元の次数と不成立を保持する', () => {
    const script = fileURLToPath(new URL('./exactRuntime/cas_legendre_test.py', import.meta.url));
    const execution = spawnSync('python', ['-B', '-X', 'utf8', script], { encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
    expect(execution.error, execution.stderr).toBeUndefined(); expect(execution.status, execution.stderr).toBe(0);
  }, 90_000);
});
