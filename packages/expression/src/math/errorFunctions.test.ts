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
import { createScalarDifferential } from './scalarDifferential.js';
import { errorFunctionDecimal } from './errorFunctionNumeric.js';
import { MathInputProblem } from './mathInputContract.js';
import { exact } from './statisticsData.js';
import { ERROR_FUNCTION_REFERENCES } from './errorFunctionReferences.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  return { source, angleUnit, notation: 'text' as const, coefficients: [],
    identity: { documentId: 'error-functions', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
}
function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  const input = request(source, angleUnit), raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
  return decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function value(source: string) {
  const result = evaluate(source).evaluation;
  if (result.status !== 'value' || result.kind !== 'real') throw new Error(source+': '+JSON.stringify(result));
  return result.coordinate;
}
function tape(source: string, angleUnit: 'degree' | 'radian' = 'radian') {
  return compileFunctionScalar(createFunctionMathSource(source, 'text', angleUnit,
    { axes: ['X'], parameters: [], coefficients: [] }, backend), ['X'], [], { backend, shouldStop: () => undefined });
}

describe('実数の誤差関数は中心と裾の小さい値を失わず、元の式を保持する', () => {
  it.each(ERROR_FUNCTION_REFERENCES)('引数$xを独立した90桁計算と相対誤差で照合する', reference => {
    for (const id of ['erf', 'erfc'] as const) {
      const expected = Number(reference[id]), actual = value(`${id}(${reference.x})`);
      if (expected === 0) expect(actual).toBe(0);
      else expect(Math.abs(actual/expected-1)).toBeLessThan(4e-14);
    }
  });
  it('中央の微小値と裾を0へ消さず、正負と補関数の関係を保つ', () => {
    expect(value('erf(1e-100)')/1e-100).toBeCloseTo(2/Math.sqrt(Math.PI), 14);
    expect(value('erfc(10)')).toBeGreaterThan(0);
    expect(value('erf(-2)')).toBe(-value('erf(2)'));
    expect(value('erfc(-2)')+value('erfc(2)')).toBeCloseTo(2, 14);
    expect(value('erf(0.5)')+value('erfc(0.5)')).toBeCloseTo(1, 14);
  });
  it('内部の補助桁を返答へ出さず40桁へ丸め、小さい値の桁は残す', () => {
    expect(errorFunctionDecimal('erfc', exact(1n), () => undefined))
      .toBe('0.1572992070502851306587793649173907407039');
    expect(errorFunctionDecimal('erfc', exact(10n), () => undefined))
      .toBe('2.088487583762544757000786294957788611561e-45');
    const result = evaluate('erfc(1)').evaluation;
    expect(JSON.stringify(result)).toContain('0.1572992070502851306587793649173907407039');
    expect(JSON.stringify(result)).not.toContain('0.157299207050285130658779364917390740703933');
  });
  it('実数と証明できる定数式と入れ子も計算し、角度は内部の三角関数だけへ適用する', () => {
    expect(value('erf(sqrt(2)/2)')).toBeCloseTo(0.6826894921370859, 14);
    expect(value('erf(sin(30))')).toBeCloseTo(value('erf(0.5)'), 14);
    expect(evaluate('erf(1)', 'degree').evaluation).toEqual(evaluate('erf(1)', 'radian').evaluation);
    expect(value('erf(erf(0))')).toBe(0);
  });
  it('倍率付きの表示変換と保存する元の文字列を分けて照合する', () => {
    const source = '2*erfc(1)+1', input = { ...request(source), presentationNotation: 'latex' as const };
    const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
    const result = decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
    if (raw.expression === null || raw.presentation === undefined || raw.presentation === null || result.definition === null) throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    expect(result.definition.source).toBe(source);
    const back = executeMathWorkRequest({ kind: 'evaluate-math', serial: 2, request: { ...input,
      notation: 'latex', source: raw.presentation.source, definition: raw.presentation, presentationNotation: 'text' } }, backend);
    if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
    expect(back.presentation.source).toBe('Add(Multiply(2,Erfc(1)),1)');
    expect(sameMathMeaning(raw.expression, back.presentation.expression)).toBe(true);
    expect(back.evaluation).toEqual(raw.evaluation);
    const saved: unknown = JSON.parse(JSON.stringify({ kind: 'evaluate-math', serial: 3, request: { ...input, definition: result.definition } }));
    const reopened = executeMathWorkRequest(saved, backend);
    expect(reopened.source).toBe(source); expect(reopened.evaluation).toEqual(raw.evaluation);
  });
  it.each([
    ['erf(1/0)', 'domain', '0では割れません。'],
    ['erfc(true)', 'domain', '誤差関数の引数は一つの数の式で指定してください。'],
    ['erf([1])', 'domain', '誤差関数の引数は一つの数の式で指定してください。'],
    ['erfc(∞)', 'domain', '誤差関数の引数は有限の値で指定してください。'],
  ] as const)('%sの不成立または未対応を0倍や成分選択で隠さない', (source, reason, detail) => {
    for (const formula of [source, `0*${source}`, `component([7,${source}],1)`]) {
      expect(evaluate(formula).evaluation).toEqual({ status: 'invalid', reason, detail });
    }
  });
  it('過大な引数・表現できない小さい値を別に拒否する', () => {
    expect(evaluate('0*erf(500001)').evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
    expect(evaluate('erfc(30)').evaluation).toMatchObject({ status: 'invalid', reason: 'non-finite' });
    const stopped = new MathInputProblem('budget', '中止');
    expect(() => errorFunctionDecimal('erfc', exact(4n), () => { throw stopped; })).toThrow(stopped);
  });
  it('関数の値と微分を独立な公式と照合し、合成と角度単位も維持する', () => {
    for (const id of ['erf', 'erfc'] as const) {
      const compiled = tape(`${id}(X)`), sample = createScalarSampler(compiled), derivative = createScalarDirectionalJet(compiled, [1]);
      const pointDerivative = createScalarDifferential(compiled);
      for (const x of [-4, -2, -0.5, 0, 0.5, 2, 4]) {
        expect(sample([x])).toBeCloseTo(value(`${id}(${x})`), 12);
        const jet = derivative([{ lower: x, upper: x }]), first = (id === 'erf' ? 1 : -1)*2/Math.sqrt(Math.PI)*Math.exp(-x*x), second = -2*x*first;
        const differential = pointDerivative([x]);
        expect(differential.reason).toBeNull(); expect(differential.gradient?.[0]).toBeCloseTo(first, 14);
        if (jet.first === null || jet.second === null) throw new Error(JSON.stringify(jet));
        expect(jet.first.lower).toBeLessThanOrEqual(first); expect(jet.first.upper).toBeGreaterThanOrEqual(first);
        expect(jet.second.lower).toBeLessThanOrEqual(second); expect(jet.second.upper).toBeGreaterThanOrEqual(second);
      }
    }
    const composed = createScalarSampler(tape('diff(erf(X^2),X)'));
    expect(composed([0.5])).toBeCloseTo(2/Math.sqrt(Math.PI)*Math.exp(-(0.5**4)), 12);
    const angle = createScalarSampler(tape('erf(sin(X))', 'degree'));
    expect(angle([30])).toBeCloseTo(value('erf(0.5)'), 12);
  });
  it('元の引数の穴を関数とその導関数の区間から消さない', () => {
    for (const source of ['erf(1/X)', 'diff(erfc(1/X),X)']) {
      const compiled = tape(source);
      expect(Number.isFinite(createScalarSampler(compiled)([0]))).toBe(false);
      expect(createScalarIntervalSampler(compiled)([{ lower: -1, upper: 1 }]).continuous).toBe(false);
    }
  });
  it('固定計算部の微分・級数・積分の結果を関数のまま受け渡す', () => {
    const script = fileURLToPath(new URL('./exactRuntime/cas_error_functions_test.py', import.meta.url));
    const execution = spawnExactRuntime(['-B', '-X', 'utf8', script], { encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
    expect(execution.error, execution.stderr).toBeUndefined(); expect(execution.status, execution.stderr).toBe(0);
  }, 90_000);
});
