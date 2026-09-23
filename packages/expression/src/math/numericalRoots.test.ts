import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { resolveNumericalRoots } from './numericalRoots.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { formatNumericalRootEndpoint } from './numericalRootResult.js';
import { decimalRational } from './exactRational.js';
import { exactDouble } from './exactDoubleInterval.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'numerical-roots', documentVersion: 2, editorId: 'X', inputRevision: 1 } };
}
function calculate(source: string, changes: Partial<MathWorkRequest> = {}) {
  const input = { ...request(source), ...changes }, raw = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
  const context = { operationsById: backend.operationsById, coefficientIds: new Set(input.coefficients.map(value => value.id)), declaredIds: new Set<string>() };
  const result = decodeMathWorkReply(raw, input, context).result;
  expect(decodeMathWorkReply(JSON.parse(JSON.stringify(raw)), input, context).result).toEqual(result);
  expect(result.definition?.source).toBe(source);
  return { input, raw, result, context };
}
function intervals(source: string, changes: Partial<MathWorkRequest> = {}) {
  const { evaluation } = calculate(source, changes).result;
  expect(evaluation).toMatchObject({ status: 'value', kind: 'root-intervals' });
  if (evaluation.status !== 'value' || evaluation.kind !== 'root-intervals') throw new Error(JSON.stringify(evaluation));
  return evaluation.intervals;
}
describe('数値で解を探す式・範囲・精度と判定できない領域を保持する', () => {
  it('表示の小数が二進数の上下限を内側へ狭めない', () => {
    for (const value of [0.1, -0.1, Math.SQRT2, -Math.SQRT2, Number.MIN_VALUE]) {
      const exact = exactDouble(value), lower = decimalRational(formatNumericalRootEndpoint(value, -1)), upper = decimalRational(formatNumericalRootEndpoint(value, 1));
      if (exact === null || lower === null || upper === null) throw new Error('表示した有限小数がありません');
      expect(lower.numerator * exact.denominator <= exact.numerator * lower.denominator).toBe(true);
      expect(upper.numerator * exact.denominator >= exact.numerator * upper.denominator).toBe(true);
    }
  });
  it.each([
    ['numericroots(x^2-2,x,-2,2,1e-7)', [-Math.SQRT2, Math.SQRT2]],
    ['numericroots(cos(x)-x,x,0,1,1e-7)', [0.7390851332151607]],
    ['numericroots(sin(x),x,-7,7,1e-7)', [-2 * Math.PI, -Math.PI, 0, Math.PI, 2 * Math.PI]],
    ['numericroots(x,x,0,2,1e-7)', [0]],
    ['numericroots(x^2+1,x,-2,2,1e-7)', []],
    ['numericroots((x-0.001)*(x+0.001),x,-1,1,1e-7)', [-0.001, 0.001]],
  ] as const)('%sで全候補の上下限と独立値を照合する', (source, expected) => {
    const result = intervals(source);
    expect(result.status).toBe('complete'); expect(result.unresolved).toEqual([]);
    expect(result.roots).toHaveLength(expected.length);
    result.roots.forEach((root, index) => {
      expect(root.lower).toBeLessThanOrEqual(expected[index]); expect(root.upper).toBeGreaterThanOrEqual(expected[index]);
      expect(root.upper - root.lower).toBeLessThanOrEqual(1e-7); expect(root.unique).toBe(true);
    });
  });
  it('度とラジアンを保存し、探索の変数へ一度だけ適用する', () => {
    const result = intervals('numericroots(sin(x),x,-200,200,1e-6)', { angleUnit: 'degree' });
    expect(result.status).toBe('complete'); expect(result.roots).toHaveLength(3);
    result.roots.forEach((root, index) => {
      expect(root.lower).toBeLessThanOrEqual((index - 1) * 180); expect(root.upper).toBeGreaterThanOrEqual((index - 1) * 180);
    });
  });
  it.each([
    ['numericroots(x^2,x,-1,1,1e-6)', 'stationary'],
    ['numericroots(1/x,x,-1,1,1e-6)', 'domain'],
    ['numericroots(0,x,-1,1,1e-6)', 'continuum'],
    ['numericroots(x-1/3,x,1/3,1,1e-6)', 'boundary'],
  ] as const)('%sの未解決を解なしに変えない', (source, reason) => {
    const result = intervals(source);
    expect(result.status).toBe('unresolved'); expect(result.roots).toEqual([]);
    expect(result.unresolved.some(region => region.reason === reason)).toBe(true);
  });
  it.each([
    'numericroots(x,x,1,0,1e-6)', 'numericroots(x,x,-1,1,0)', 'numericroots(x,x,-∞,1,1e-6)',
    'numericroots(x,x,-1,1,1e-999)',
    'rootinterval(numericroots(x,x,-1,1,1e-6),0)',
    'rootinterval(numericroots(x^2,x,-1,1,1e-6),1)',
    '0*component(rootinterval(numericroots(1/x,x,-1,1,1e-6),1),1)',
    'rootinterval(numericroots(x^2+1,x,-1,1,1e-6),1)',
  ])('%sの指定不足や不成立を勝手に補完しない', source => {
    expect(calculate(source).result.evaluation.status).not.toBe('value');
  });
  it('未宣言の文字がある入力を保存可能な式として通さない', () => {
    const input = request('numericroots(x+y,x,-1,1,1e-6)');
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    expect(reply.expression).toBeNull(); expect(reply.evaluation.status).toBe('invalid');
  });
  it('元の割り算の穴を0倍でも消さず、途中候補を使わせない', () => {
    const result = intervals('numericroots(x+0*(1/x),x,-1,1,1e-6)');
    expect(result.status).toBe('unresolved'); expect(result.roots).toEqual([]);
    expect(result.unresolved.some(region => region.reason === 'domain')).toBe(true);
  });
  it('候補の下限と上限は別の正確な数として明示して選ぶ', () => {
    const values = [1, 2].map(index => calculate(`component(rootinterval(numericroots(x^2-2,x,0,2,1e-6),1),${index})`).result.evaluation);
    for (const value of values) expect(value).toMatchObject({ status: 'value', kind: 'real', approximation: null });
    const [lower, upper] = values;
    if (lower.status !== 'value' || lower.kind !== 'real' || upper.status !== 'value' || upper.kind !== 'real') throw new Error('上下限がありません');
    expect(lower.coordinate).toBeLessThan(Math.SQRT2); expect(upper.coordinate).toBeGreaterThan(Math.SQRT2);
    expect(upper.coordinate - lower.coordinate).toBeLessThan(1e-6);
  });
  it('通常と構造入力の切替とJSON往復で未知数・範囲・精度を保つ', () => {
    const source = 'numericroots(x^2-2,x,-2,2,1e-6)', input = request(source);
    const original = calculate(source).raw;
    const converted = executeMathWorkRequest(createMathWorkEnvelope(2, { ...input, presentationNotation: 'latex' }), backend);
    if (converted.presentation === undefined || converted.presentation === null || original.expression === null) throw new Error('表示がありません');
    const restored = calculate(converted.presentation.source, { notation: 'latex' }).raw;
    if (restored.expression === null) throw new Error('構造入力を読めません');
    expect(sameMathMeaning(original.expression, restored.expression)).toBe(true);
    expect(restored.evaluation.status).toBe('value');
  });
  it.each([[2, 2], [5, 3]] as const)('解の上限を整数へ切り上げる操作でx²−%sから%sを使える', (square, expected) => {
    const source = `ceil(component(rootinterval(numericroots(x^2-${square},x,0,3,0.000001),1),2))`;
    const result = calculate(source).result.evaluation;
    expect(result).toMatchObject({ status: 'value', kind: 'real', coordinate: expected, approximation: null });
  });
  it('未知数と同名の係数を混同せず、変更した値で再計算する', () => {
    const source = 'numericroots(x-coef("x"),x,0,4,1e-6)';
    for (const value of [1, 3]) {
      const result = intervals(source, { coefficients: [{ id: 'offset', label: 'x', decimal: String(value) }] });
      expect(result.status).toBe('complete'); expect(result.roots).toHaveLength(1);
      expect(result.roots[0].lower).toBeLessThanOrEqual(value); expect(result.roots[0].upper).toBeGreaterThanOrEqual(value);
    }
  });
  it('選んだ区間の成分を関数の定数へ使い、標本ごとに解き直さない', () => {
    const definition = createFunctionMathSource('T+ceil(component(rootinterval(numericroots(x^2-2,x,0,2,1e-6),1),2))', 'text', 'radian',
      { axes: [], parameters: ['T'], coefficients: [] }, backend);
    const tape = compileFunctionScalar(definition, ['T'], [], { backend, shouldStop: () => undefined });
    const sample = createScalarSampler(tape);
    expect(sample([0])).toBe(2); expect(sample([3])).toBe(5);
  });
  it.each(['cancelled', 'deadline'] as const)('%sでは途中の根を返さない', reason => {
    const source = calculate('numericroots(x^2-2,x,-2,2,1e-6)').raw.expression;
    if (source === null) throw new Error('原式がありません');
    const result = resolveNumericalRoots(source, source, { backend, angleUnit: 'radian', shouldStop: () => reason });
    expect(result).toEqual({ evaluation: { status: 'stopped', reason } });
  });
  it('追加の計算部を起動せずに区間を確認する', async () => {
    const evaluate = vi.fn(() => Promise.resolve(null));
    const result = await executeExactMathWorkRequest(createMathWorkEnvelope(3, request('numericroots(x^2-2,x,-2,2,1e-6)')),
      { backend, engine: { evaluate }, shouldStop: () => undefined });
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'root-intervals' }); expect(evaluate).not.toHaveBeenCalled();
  });
  it('元の式、上下限、一意性、精度、未解決の有無を偽った返信を拒否する', () => {
    const { raw, input, context } = calculate('numericroots(x^2-2,x,0,2,1e-6)');
    if (raw.evaluation.status !== 'value' || raw.evaluation.kind !== 'root-intervals') throw new Error('区間がありません');
    const value = raw.evaluation, root = value.intervals.roots[0];
    for (const intervals of [
      { ...value.intervals, roots: [{ ...root, lower: root.upper, upper: root.lower }] },
      { ...value.intervals, roots: [{ ...root, unique: false }] },
      { ...value.intervals, roots: [root, root] },
      { ...value.intervals, tolerance: 0 },
      { ...value.intervals, status: 'unresolved' },
      { ...value.intervals, unresolved: [{ lower: 0, upper: 1, reason: 'stationary' }] },
    ]) expect(() => decodeMathWorkReply({ ...raw, evaluation: { ...value, intervals } }, input, context)).toThrow();
    const another = calculate('numericroots(x^2-3,x,0,2,1e-6)').raw.expression;
    expect(() => decodeMathWorkReply({ ...raw, evaluation: { ...value, expression: another } }, input, context)).toThrow();
  });
});
