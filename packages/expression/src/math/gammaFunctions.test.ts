import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { GAMMA_FUNCTION_REFERENCES } from './gammaFunctionReferences.js';
import { POLYGAMMA_REFERENCES } from './polygammaReferences.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  return { source, angleUnit, notation: 'text' as const, coefficients: [],
    identity: { documentId: 'gamma-functions', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
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

describe('Gammaと微分した式を元の入力のまま数値へ渡す', () => {
  it.each(GAMMA_FUNCTION_REFERENCES.filter(([, text]) => Number.isFinite(Number(text)) && Number(text) !== 0))(
    'Gamma(%s)を独立な計算値へ照合する', (input, expected) => {
      expect(Math.abs(value(`gamma(${input})`)/Number(expected)-1)).toBeLessThan(5e-14);
    });
  it.each(POLYGAMMA_REFERENCES.filter(([, input]) => ['-3.5','0.5','1','3.25'].includes(input)))(
    'polygamma(%s,%s)を次数と引数を入れ替えず渡す', (order, input, expected) => {
      expect(Math.abs(value(`polygamma(${order},${input})`)/Number(expected)-1)).toBeLessThan(5e-14);
    });
  it('正の整数・半整数の結果全文を保持し、入力側の角度単位だけを使う', () => {
    expect(value('gamma(5)')).toBe(24); expect(value('gamma(6)')).toBe(120);
    expect(JSON.stringify(evaluate('gamma(0.5)').evaluation)).toContain('1.772453850905516027298167483341145182798');
    expect(JSON.stringify(evaluate('polygamma(0,1)').evaluation)).toContain('-0.5772156649015328606065120900824024310422');
    expect(evaluate('gamma(0.5)', 'degree').evaluation).toEqual(evaluate('gamma(0.5)', 'radian').evaluation);
    expect(value('gamma(sin(30))')).toBeCloseTo(Math.sqrt(Math.PI), 14);
    expect(value('gamma(sqrt(2))')).toBeCloseTo(0.8865814287192592, 14);
    expect(value('gamma(gamma(3))')).toBe(1);
  });
  it('元の分数と極の非常に近くの値を丸めて整数にしない', () => {
    expect(value('gamma(-1+1e-100)')/-1e100).toBeCloseTo(1, 14);
    expect(value('gamma(-1-1e-100)')/1e100).toBeCloseTo(1, 14);
    expect(value('polygamma(0,-1+1e-100)')/-1e100).toBeCloseTo(1, 14);
    expect(value('polygamma(1,-1-1e-100)')/1e200).toBeCloseTo(1, 14);
  });
  it('構造入力の意味と、保存した原文を区別して往復する', () => {
    const source = '2*gamma(5)+polygamma(0,1)', input = { ...request(source), presentationNotation: 'latex' as const };
    const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: input }, backend);
    const result = decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
    if (raw.expression === null || raw.presentation === undefined || raw.presentation === null || result.definition === null) throw new Error(JSON.stringify(raw));
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    expect(result.definition.source).toBe(source);
    const back = executeMathWorkRequest({ kind: 'evaluate-math', serial: 2, request: { ...input,
      notation: 'latex', source: raw.presentation.source, definition: raw.presentation, presentationNotation: 'text' } }, backend);
    if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
    expect(back.presentation.source).toBe('Add(Multiply(2,Gamma(5)),Polygamma(0,1))');
    expect(sameMathMeaning(raw.expression, back.presentation.expression)).toBe(true); expect(back.evaluation).toEqual(raw.evaluation);
    const saved: unknown = JSON.parse(JSON.stringify({ kind: 'evaluate-math', serial: 3, request: { ...input, definition: result.definition } }));
    const reopened = executeMathWorkRequest(saved, backend);
    expect(reopened.source).toBe(source); expect(reopened.evaluation).toEqual(raw.evaluation);
  });
  it.each([
    ['gamma(0)', 'domain', 'Gamma関数には0と負の整数を指定できません。'],
    ['gamma(-2)', 'domain', 'Gamma関数には0と負の整数を指定できません。'],
    ['polygamma(1,-1)', 'domain', 'Gamma関数には0と負の整数を指定できません。'],
    ['polygamma(0.5,1)', 'domain', 'Gamma関数の微分の次数は0から17までの整数で指定してください。'],
    ['polygamma(18,1)', 'domain', 'Gamma関数の微分の次数は0から17までの整数で指定してください。'],
    ['gamma(true)', 'domain', 'Gamma関数の引数は実数の式で指定してください。'],
    ['gamma([1])', 'domain', 'Gamma関数の引数は実数の式で指定してください。'],
    ['gamma(∞)', 'domain', 'Gamma関数の引数は有限の値で指定してください。'],
    ['gamma(i)', 'unsupported', 'Gamma関数の複素引数の数値計算にはまだ対応していません。'],
  ] as const)('%sの不成立を0倍や成分選択で隠さない', (source, reason, detail) => {
    for (const formula of [source, `0*${source}`, `component([7,${source}],1)`]) {
      expect(evaluate(formula).evaluation).toEqual({ status: 'invalid', reason, detail });
    }
  });
  it('元の0割り・未証明の極・過大な数を拒否する', () => {
    for (const source of ['gamma(1/0)','0*gamma(sqrt(-1))','gamma(-1+sin(1e-100))']) expect(evaluate(source).evaluation.status).not.toBe('value');
    expect(evaluate('0*gamma(20001)').evaluation).toMatchObject({ status: 'stopped', reason: 'budget' });
    expect(evaluate('polygamma(17,1e-100)').evaluation).toMatchObject({ status: 'invalid', reason: 'non-finite' });
  });
  it('固定計算部のGamma・点の微分・級数・極の条件を同じ式へ戻す', () => {
    const script = fileURLToPath(new URL('./exactRuntime/cas_gamma_functions_test.py', import.meta.url));
    const execution = spawnExactRuntime(['-B', '-X', 'utf8', script], { encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
    expect(execution.error, execution.stderr).toBeUndefined(); expect(execution.status, execution.stderr).toBe(0);
  }, 90_000);
  it('実際の追加計算の返信を数値へ渡し、保存再開でも原式と厳密な答えを保つ', async () => {
    const engine = sharedExactEngine(exactRuntimeBatch(fileURLToPath(new URL('./exactRuntime/cas_derivatives_test.py',
      import.meta.url)), 60_000), 'Gammaの返信数が一致しません。');
    const gammaAtOne = GAMMA_FUNCTION_REFERENCES.find(([input]) => input === '1');
    if (gammaAtOne === undefined) throw new Error('独立した微分の基準値がありません。');
    const calculated = await Promise.all(([
      ['derivativeat(gamma(x),x,1)', Number(gammaAtOne[2])],
      ['derivativeat(gamma(x),x,1,2)', Number(gammaAtOne[3])],
      ['component(gradientat(gamma(x),[x],[1]),1)', Number(gammaAtOne[2])],
    ] as const).map(async ([source, expected]) => {
      const input = request(source), envelope = { kind: 'evaluate-math', serial: 4, request: input };
      return { source, expected, input, envelope,
        raw: await executeExactMathWorkRequest(envelope, { backend, engine, shouldStop: () => undefined }) };
    }));
    const reopenedRuns = await Promise.all(calculated.map(async ({ source, expected, input, envelope, raw }) => {
      const result = decodeMathWorkReply(raw, input, { operationsById: CANDIDATE_MATH_BY_ID,
        coefficientIds: new Set(), declaredIds: new Set() }).result;
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null) throw new Error(JSON.stringify(result));
      expect(result.evaluation.coordinate).toBeCloseTo(expected, 12); expect(result.evaluation.exact).not.toBeNull();
      expect(result.definition.source).toBe(source);
      const saved: unknown = JSON.parse(JSON.stringify({ ...envelope, request: { ...input, definition: result.definition } }));
      return { source, raw, reopened: await executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined }) };
    }));
    for (const { source, raw, reopened } of reopenedRuns) {
      expect(reopened.source).toBe(source); expect(reopened.evaluation).toEqual(raw.evaluation);
    }
  }, 90_000);
});
